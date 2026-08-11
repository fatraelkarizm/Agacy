use anchor_lang::prelude::*;

use crate::{
    confidential_limits::{
        add_ciphertexts, read_equality_context, read_transfer_amount_ciphertext,
        require_equality_over, subtract_ciphertexts, verify_range_context, CiphertextBytes,
        ENCRYPTED_ZERO,
    },
    custody_guard::{classify_cpi, require_bound_confidential_transfer, CpiKind},
    error::PolicyError,
    instructions::authorize_and_invoke::{forward_as_policy_pda, require_custodied_source},
    state::Policy,
};

/// The confidential-limit enforcement path. See confidential_limits.rs for how
/// and why this works at all; this file is the plumbing around it.

#[derive(Accounts)]
pub struct SetConfidentialLimits<'info> {
    #[account(mut, has_one = owner @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub owner: Signer<'info>,
}

/// Switches a policy from visible limits to encrypted ones.
///
/// Owner-only, and one-directional by intent: there is no "reveal my limits
/// again" instruction, because the ciphertexts an observer already recorded do
/// not become private again afterwards. Re-encrypting under a fresh key is the
/// meaningful operation, and calling this a second time does exactly that.
///
/// The spent-total is reset here rather than carried over. It was encrypted
/// under the old key (or not encrypted at all), so it cannot be combined
/// homomorphically with anything under the new one — carrying it would produce
/// ciphertexts that decrypt to nonsense, which is worse than restarting the
/// period.
pub fn handle_set_confidential_limits(
    ctx: Context<SetConfidentialLimits>,
    limit_pubkey: [u8; 32],
    max_per_transfer_ct: CiphertextBytes,
    max_per_period_ct: CiphertextBytes,
) -> Result<()> {
    require!(limit_pubkey != [0u8; 32], PolicyError::ProofUnderWrongKey);

    let policy = &mut ctx.accounts.policy;
    // Clear the legacy fields so the current account state does not retain a
    // readable copy. This cannot erase the historical initialize transaction;
    // new private policies must use `initialize_confidential` for that.
    policy.max_per_transfer = 0;
    policy.max_per_period = 0;
    policy.limit_pubkey = limit_pubkey;
    policy.max_per_transfer_ct = max_per_transfer_ct;
    policy.max_per_period_ct = max_per_period_ct;
    policy.spent_in_period_ct = ENCRYPTED_ZERO;
    policy.spent_in_period = 0;
    policy.period_start = Clock::get()?.unix_timestamp;
    Ok(())
}

/// The three proof-context accounts every confidential authorization needs.
///
/// Named accounts rather than `remaining_accounts` on purpose: the CPI-forwarding
/// variant below still needs `remaining_accounts` for the instruction it
/// forwards, and mixing the two would make the account list positional in a way
/// that is easy to get wrong and impossible to check.
#[derive(Accounts)]
pub struct AuthorizeConfidential<'info> {
    #[account(mut, has_one = agent @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub agent: Signer<'info>,
    /// CHECK: required to be a ZK ElGamal Proof program context account proving
    /// `max_per_transfer - amount` is non-negative; validated in confidential_limits.rs.
    pub transfer_equality_proof: UncheckedAccount<'info>,
    /// CHECK: same, for `max_per_period - (spent + amount)`.
    pub period_equality_proof: UncheckedAccount<'info>,
    /// CHECK: the batched range proof covering both differences.
    pub range_proof: UncheckedAccount<'info>,
}

pub fn handle_authorize_confidential(
    ctx: Context<AuthorizeConfidential>,
    amount_ct: CiphertextBytes,
) -> Result<()> {
    apply_confidential_check(
        &mut ctx.accounts.policy,
        &amount_ct,
        &ctx.accounts.transfer_equality_proof,
        &ctx.accounts.period_equality_proof,
        &ctx.accounts.range_proof,
    )
}

#[derive(Accounts)]
pub struct AuthorizeConfidentialAndInvoke<'info> {
    #[account(mut, has_one = agent @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub agent: Signer<'info>,
    /// CHECK: forwarded verbatim as the CPI's program id, and required by
    /// `classify_cpi` to be SPL Token or Token-2022.
    pub target_program: UncheckedAccount<'info>,
    /// CHECK: see AuthorizeConfidential.
    pub transfer_equality_proof: UncheckedAccount<'info>,
    /// CHECK: see AuthorizeConfidential.
    pub period_equality_proof: UncheckedAccount<'info>,
    /// CHECK: see AuthorizeConfidential.
    pub range_proof: UncheckedAccount<'info>,
    /// CHECK: Token-2022's verified transfer-validity context. Its owner, proof
    /// type, source key, and forwarded-account position are checked below.
    pub transfer_validity_proof: UncheckedAccount<'info>,
}

/// The confidential twin of `authorize_and_invoke`: same CPI allowlist, same
/// custodied-source check, same PDA signing — only the budget test differs.
pub fn handle_authorize_confidential_and_invoke(
    ctx: Context<AuthorizeConfidentialAndInvoke>,
    instruction_data: Vec<u8>,
) -> Result<()> {
    let kind = classify_cpi(ctx.accounts.target_program.key, &instruction_data)?;
    require!(kind == CpiKind::Spend, PolicyError::NotASpendInstruction);
    require_bound_confidential_transfer(&instruction_data)?;
    require_custodied_source(&ctx.accounts.policy, ctx.remaining_accounts)?;

    // With all proof offsets zero, Token-2022 omits the optional instructions
    // sysvar and ConfidentialTransfer account #4 is the validity record.
    // Matching it here binds our amount to the proof consumed by the CPI.
    let forwarded_validity = ctx
        .remaining_accounts
        .get(4)
        .ok_or(PolicyError::MissingCpiAccounts)?;
    require_keys_eq!(
        forwarded_validity.key(),
        ctx.accounts.transfer_validity_proof.key(),
        PolicyError::TransferProofAccountMismatch
    );
    let amount_ct = read_transfer_amount_ciphertext(
        &ctx.accounts.transfer_validity_proof,
        &ctx.accounts.policy.limit_pubkey,
    )?;

    apply_confidential_check(
        &mut ctx.accounts.policy,
        &amount_ct,
        &ctx.accounts.transfer_equality_proof,
        &ctx.accounts.period_equality_proof,
        &ctx.accounts.range_proof,
    )?;

    let policy_key = ctx.accounts.policy.key();
    forward_as_policy_pda(
        &ctx.accounts.policy,
        policy_key,
        ctx.accounts.target_program.key,
        instruction_data,
        ctx.remaining_accounts,
    )
}

/// The check itself, shared by both entry points so the two can never drift.
///
/// Read alongside `apply_policy_check` in authorize.rs — this is the same
/// decision (is this spend within both limits, and roll the period if it has
/// elapsed) expressed entirely over ciphertexts. The one structural difference
/// is that nothing here can *compare*; it can only compute differences and
/// then require that somebody has already proved those differences are
/// non-negative.
fn apply_confidential_check(
    policy: &mut Policy,
    amount_ct: &CiphertextBytes,
    transfer_equality_proof: &UncheckedAccount,
    period_equality_proof: &UncheckedAccount,
    range_proof: &UncheckedAccount,
) -> Result<()> {
    require!(
        policy.has_confidential_limits(),
        PolicyError::NoConfidentialLimits
    );

    let now = Clock::get()?.unix_timestamp;
    if now.saturating_sub(policy.period_start) >= policy.period_seconds {
        policy.spent_in_period_ct = ENCRYPTED_ZERO;
        policy.period_start = now;
    }

    // Both differences are computed here, from state this program already
    // holds, so the proofs below are forced to be about these numbers rather
    // than about anything the caller would have preferred.
    let transfer_difference = subtract_ciphertexts(&policy.max_per_transfer_ct, amount_ct)?;
    let new_spent = add_ciphertexts(&policy.spent_in_period_ct, amount_ct)?;
    let period_difference = subtract_ciphertexts(&policy.max_per_period_ct, &new_spent)?;

    let transfer_context = read_equality_context(transfer_equality_proof)?;
    require_equality_over(&transfer_context, &policy.limit_pubkey, &transfer_difference)?;

    let period_context = read_equality_context(period_equality_proof)?;
    require_equality_over(&period_context, &policy.limit_pubkey, &period_difference)?;

    // Each equality proof only says "this ciphertext and this commitment hold
    // the same value" — on its own that is compatible with the value being
    // negative. The range proof is what rules that out, and it must cover
    // exactly the two commitments just bound above, or it is a proof about
    // some other pair of numbers entirely.
    verify_range_context(
        range_proof,
        &transfer_context.commitment,
        &period_context.commitment,
    )?;

    policy.spent_in_period_ct = new_spent;
    Ok(())
}
