use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::{
    custody_guard::{classify_cpi, require_non_confidential_spend, CpiKind},
    error::PolicyError,
    instructions::authorize::apply_policy_check,
    state::Policy,
};

/// This is the instruction that actually closes the *structural* bypass
/// described in docs/PRIVACY_ARCHITECTURE.md section 14: `authorize` (in
/// authorize.rs) only records that an amount is within policy — nothing
/// stops an agent that separately holds delegate/owner authority over a
/// token account from calling Token-2022 directly and skipping this program
/// entirely. Here, the policy PDA itself is the authority the token account
/// answers to, and only this program can produce a valid signature for that
/// PDA (via `invoke_signed`) — so the only way to spend through it is to pass
/// this program's policy check first.
///
/// Two things bound what that signature can be spent on. Both arrived with
/// the owner-PDA custody model and both are load-bearing rather than
/// defensive extras (custody_guard.rs has the full argument):
///
/// 1. `classify_cpi` — the forwarded instruction must be a *transfer* on a
///    token program. Without it, `amount = 1` plus a `SetAuthority` payload
///    is a complete custody escape bought with one unit of budget.
/// 2. `require_custodied_source` — while custody is held, the PDA's signature
///    may only move funds out of the exact account this policy custodies, so
///    one policy cannot be borrowed as a signing oracle for a different
///    account that happens to answer to the same PDA.
///
/// What this still does NOT close, and cannot, without the cryptographic
/// work section 14.3 describes as open: the amount encoded in a confidential
/// transfer's ciphertext is opaque to this program. It can confirm the
/// *claimed* amount is within limits; it cannot confirm the encrypted
/// instruction it forwards actually moves that exact amount. That is a
/// distinct, harder problem than delegate binding or custody, and nothing
/// here should be read as addressing it.
#[derive(Accounts)]
pub struct AuthorizeAndInvoke<'info> {
    #[account(mut, has_one = agent @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub agent: Signer<'info>,
    /// CHECK: forwarded verbatim as the CPI's program id, and required by
    /// `classify_cpi` to be SPL Token or Token-2022.
    pub target_program: UncheckedAccount<'info>,
}

pub fn handle_authorize_and_invoke(
    ctx: Context<AuthorizeAndInvoke>,
    amount: u64,
    instruction_data: Vec<u8>,
) -> Result<()> {
    let kind = classify_cpi(ctx.accounts.target_program.key, &instruction_data)?;
    require!(kind == CpiKind::Spend, PolicyError::NotASpendInstruction);
    require_non_confidential_spend(&instruction_data)?;
    require_custodied_source(&ctx.accounts.policy, ctx.remaining_accounts)?;

    apply_policy_check(&mut ctx.accounts.policy, amount)?;

    let policy_key = ctx.accounts.policy.key();
    forward_as_policy_pda(
        &ctx.accounts.policy,
        policy_key,
        ctx.accounts.target_program.key,
        instruction_data,
        ctx.remaining_accounts,
    )
}

/// Every instruction this program is willing to forward puts the account
/// being debited first — classic `Transfer` (`[source, destination,
/// authority]`), `TransferChecked` (`[source, mint, destination, authority]`),
/// confidential `Transfer` (`[source, mint, destination, ...proof accounts,
/// authority]`) and `ApplyPendingBalance` (`[account, authority]`) all agree
/// on index 0. That shared shape is what makes this check possible without
/// decoding each instruction's full account layout.
pub fn require_custodied_source(policy: &Policy, remaining_accounts: &[AccountInfo]) -> Result<()> {
    if !policy.holds_custody() {
        // Delegate mode: this policy was never told which account it is
        // delegated over, so there is nothing to compare against. The token
        // program's own delegate check is the binding constraint there.
        return Ok(());
    }

    let source = remaining_accounts
        .first()
        .ok_or(PolicyError::MissingCpiAccounts)?;
    require!(
        source.key() == policy.custodied_token_account,
        PolicyError::CpiSourceMismatch
    );
    Ok(())
}

/// Forwards `instruction_data` to `target_program` with `remaining_accounts`,
/// signing as the policy PDA.
///
/// Every account keeps the signer/writable flags it arrived with — only the
/// policy PDA is forced to `is_signer: true`, because nothing in the outer
/// transaction could have signed for it; that signature only exists once
/// `invoke_signed` supplies the seeds.
pub fn forward_as_policy_pda(
    policy: &Policy,
    policy_key: Pubkey,
    target_program: &Pubkey,
    instruction_data: Vec<u8>,
    remaining_accounts: &[AccountInfo],
) -> Result<()> {
    let account_metas: Vec<AccountMeta> = remaining_accounts
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
        program_id: *target_program,
        accounts: account_metas,
        data: instruction_data,
    };

    let seeds = Policy::signer_seeds(&policy.owner, &policy.agent);
    let signer_seeds: &[&[u8]] = &[seeds[0], seeds[1], seeds[2], &[policy.bump]];

    invoke_signed(&cpi_instruction, remaining_accounts, &[signer_seeds])?;
    Ok(())
}
