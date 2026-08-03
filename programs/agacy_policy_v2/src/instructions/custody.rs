//! Taking custody of a token account, and — non-negotiably — giving it back.
//!
//! Why custody at all: Token-2022's confidential `Transfer` does not consult a
//! token account's delegate fields. It was tried for real on devnet with
//! `delegatedAmount` set to `u64::MAX` to rule out an amount-check false
//! negative, and it still fails with `OwnerMismatch` at identical compute cost
//! (`scripts/verify-confidential-delegate-devnet.ts`). Delegation is not a
//! weaker version of what we need; for confidential transfer it is simply not
//! a mechanism at all. The authority must literally be the account's owner.
//!
//! Why `release_custody` ships in the same commit as `assume_custody`, rather
//! than "later": the delegate model has a safety net that the custody model
//! deletes. A delegate can be revoked by the owner directly through the token
//! program, with no cooperation from this program required — if this program
//! were buggy, frozen, or simply undeployed tomorrow, the owner's funds would
//! still be reachable. The moment the PDA becomes the owner, that stops being
//! true: the *only* signature that can move or re-assign the account is one
//! this program produces. Shipping custody without a tested way out would mean
//! a bug in this program can strand real funds permanently, with no human
//! override. That is not a trade worth making to save an afternoon, and it is
//! worse for exactly the multi-agent operator this project is aimed at — every
//! custodied account shares this one program's code, so a single bug is a
//! correlated failure across all of them rather than an isolated one.
//!
//! So: `release_custody` is owner-signed, takes no policy checks of any kind,
//! consults neither the clock nor the spend budget, and works while the period
//! limit is fully exhausted. It is deliberately the least conditional
//! instruction in this program.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};

use crate::{constants::*, error::PolicyError, state::Policy};

/// `SetAuthority { authority_type, new_authority }` in SPL Token's wire
/// format, shared by both token programs and unchanged since launch:
/// tag(1) | authority_type(1) | COption tag(1) | new_authority(32).
///
/// Hand-encoded for the same reason `tests/delegate_cpi.rs` hand-encodes its
/// instructions: no published `spl-token` release depends on the same
/// generation of `Pubkey`/`Instruction` types as anchor-lang 1.1.2.
fn set_account_owner_ix(
    token_program: Pubkey,
    token_account: Pubkey,
    current_authority: Pubkey,
    new_authority: Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(35);
    data.push(token_ix::SET_AUTHORITY);
    data.push(AUTHORITY_TYPE_ACCOUNT_OWNER);
    data.push(1); // COption::Some
    data.extend_from_slice(new_authority.as_ref());

    Instruction {
        program_id: token_program,
        accounts: vec![
            AccountMeta::new(token_account, false),
            AccountMeta::new_readonly(current_authority, true),
        ],
        data,
    }
}

fn require_token_program(program: &Pubkey) -> Result<()> {
    require!(
        *program == SPL_TOKEN_ID || *program == TOKEN_2022_ID,
        PolicyError::ForbiddenCpiProgram
    );
    Ok(())
}

#[derive(Accounts)]
pub struct AssumeCustody<'info> {
    #[account(mut, has_one = owner @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    /// The current owner of `token_account`, handing it over. Signs here, and
    /// is the only key `release_custody` will ever answer to afterwards.
    pub owner: Signer<'info>,
    /// CHECK: not interpreted here — the token program rejects the CPI unless
    /// this is a token account `owner` currently has authority over.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: constrained to SPL Token or Token-2022 below.
    pub token_program: UncheckedAccount<'info>,
}

pub fn handle_assume_custody(ctx: Context<AssumeCustody>) -> Result<()> {
    require!(
        !ctx.accounts.policy.holds_custody(),
        PolicyError::CustodyAlreadyHeld
    );
    require_token_program(ctx.accounts.token_program.key)?;

    // Plain `invoke`, not `invoke_signed`: at this point the owner is still
    // the account's authority and signs the outer transaction. The PDA has no
    // authority to sign with yet — acquiring it is what this call does.
    invoke(
        &set_account_owner_ix(
            *ctx.accounts.token_program.key,
            ctx.accounts.token_account.key(),
            ctx.accounts.owner.key(),
            ctx.accounts.policy.key(),
        ),
        &[
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
    )?;

    // Recorded only after the CPI succeeds, so a failed handover cannot leave
    // the policy claiming custody it does not have.
    ctx.accounts.policy.custodied_token_account = ctx.accounts.token_account.key();
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseCustody<'info> {
    #[account(mut, has_one = owner @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    /// The owner recorded at `initialize`. The agent cannot reach this
    /// instruction — `has_one = owner` is the whole access control, and it is
    /// checked against stored state rather than anything the caller supplies.
    pub owner: Signer<'info>,
    /// CHECK: required to equal the recorded custodied account below.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: constrained to SPL Token or Token-2022 below.
    pub token_program: UncheckedAccount<'info>,
}

/// Hands the token account's ownership back to `new_authority`, chosen by the
/// owner — normally themselves, but a separate rescue wallet is a legitimate
/// choice too, so this is an argument rather than hardcoded to `owner`.
///
/// Note what is deliberately absent: no `apply_policy_check`, no `Clock`, no
/// reference to `spent_in_period`. An owner whose agent has exhausted its
/// budget, or whose policy period math is somehow wrong, must still be able to
/// get their account back.
pub fn handle_release_custody(ctx: Context<ReleaseCustody>, new_authority: Pubkey) -> Result<()> {
    require!(
        ctx.accounts.policy.custodied_token_account == ctx.accounts.token_account.key(),
        PolicyError::NoCustodyHeld
    );
    require_token_program(ctx.accounts.token_program.key)?;

    let owner = ctx.accounts.policy.owner;
    let agent = ctx.accounts.policy.agent;
    let bump = ctx.accounts.policy.bump;
    let seeds = Policy::signer_seeds(&owner, &agent);
    let signer_seeds: &[&[u8]] = &[seeds[0], seeds[1], seeds[2], &[bump]];

    invoke_signed(
        &set_account_owner_ix(
            *ctx.accounts.token_program.key,
            ctx.accounts.token_account.key(),
            ctx.accounts.policy.key(),
            new_authority,
        ),
        &[
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.policy.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    ctx.accounts.policy.custodied_token_account = Pubkey::default();
    Ok(())
}
