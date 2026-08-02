use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::{constants::*, error::PolicyError, instructions::authorize::apply_policy_check, state::Policy};

/// This is the instruction that actually closes the *structural* bypass
/// described in docs/PRIVACY_ARCHITECTURE.md section 14: `authorize` (in
/// authorize.rs) only records that an amount is within policy — nothing
/// stops an agent that separately holds delegate/owner authority over a
/// token account from calling Token-2022 directly and skipping this program
/// entirely. Here, the policy PDA itself is the delegate the token account
/// approves, and only this program can produce a valid signature for that
/// PDA (via `invoke_signed`) — so the only way to spend through this
/// delegate is to pass this program's policy check first.
///
/// What this still does NOT close, and cannot, without the cryptographic
/// work section 14.3 describes as open: the amount passed to the CPI'd
/// instruction is opaque bytes built by the caller. For a confidential
/// transfer specifically, this program cannot decrypt the transfer amount
/// to confirm it equals the `amount` used for the policy check above — it
/// can only confirm the *policy-checked* amount is within limits, not that
/// the encrypted instruction it's about to forward actually moves that
/// exact amount. Closing that gap is a distinct, harder problem than
/// delegate binding itself.
#[derive(Accounts)]
pub struct AuthorizeAndInvoke<'info> {
    #[account(mut, has_one = agent @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub agent: Signer<'info>,
    /// CHECK: the program the CPI targets — forwarded verbatim as the CPI's
    /// program id, never read or interpreted by this program.
    pub target_program: UncheckedAccount<'info>,
}

pub fn handle_authorize_and_invoke(
    ctx: Context<AuthorizeAndInvoke>,
    amount: u64,
    instruction_data: Vec<u8>,
) -> Result<()> {
    apply_policy_check(&mut ctx.accounts.policy, amount)?;

    let policy_key = ctx.accounts.policy.key();
    let owner = ctx.accounts.policy.owner;
    let agent = ctx.accounts.policy.agent;
    let bump = ctx.accounts.policy.bump;

    // Every other account keeps the signer/writable flags it arrived with —
    // only the policy PDA is forced to `is_signer: true` here, because
    // nothing in the outer transaction could have signed for it; that
    // signature only exists once `invoke_signed` supplies the seeds below.
    let account_metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|account| {
            let is_signer = account.key() == policy_key || account.is_signer;
            if account.is_writable {
                AccountMeta::new(*account.key, is_signer)
            } else {
                AccountMeta::new_readonly(*account.key, is_signer)
            }
        })
        .collect();

    let cpi_instruction = Instruction {
        program_id: *ctx.accounts.target_program.key,
        accounts: account_metas,
        data: instruction_data,
    };

    let seeds: &[&[u8]] = &[POLICY_SEED, owner.as_ref(), agent.as_ref(), &[bump]];
    invoke_signed(&cpi_instruction, ctx.remaining_accounts, &[seeds])?;

    Ok(())
}
