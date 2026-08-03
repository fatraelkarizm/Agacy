use anchor_lang::prelude::*;

use crate::{error::PolicyError, state::Policy};

/// The enforcement point — identical policy math to the native program's
/// `Policy::authorize`, reimplemented here rather than shared, since the two
/// live in separate, deliberately isolated Cargo workspaces (see
/// program/Cargo.toml's `[workspace]` comment). Kept byte-for-byte equivalent
/// in behavior, verified by tests/policy_flow.rs mirroring the native
/// program's own test cases.
///
/// This instruction only records that `amount` is within policy — it does
/// NOT itself move any funds. Wiring a CPI into a token transfer here (so the
/// agent literally cannot spend without this instruction succeeding first)
/// is the next step described in docs/PRIVACY_ARCHITECTURE.md section 14,
/// and deliberately not implemented in this pass: it requires forwarding the
/// confidential-transfer proof-context accounts, and this program still has
/// no way to verify that `amount` matches the transfer's actual (encrypted)
/// value — see section 14.3 for why that remains open rather than papered over.
#[derive(Accounts)]
pub struct Authorize<'info> {
    #[account(mut, has_one = agent @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub agent: Signer<'info>,
}

pub fn handle_authorize(ctx: Context<Authorize>, amount: u64) -> Result<()> {
    apply_policy_check(&mut ctx.accounts.policy, amount)
}

/// Shared by `authorize` and `authorize_and_invoke` (authorize_and_invoke.rs)
/// so the two enforcement paths can never silently drift apart.
pub fn apply_policy_check(policy: &mut Policy, amount: u64) -> Result<()> {
    // Once the owner has moved to encrypted limits, the plaintext `max_per_*`
    // fields are no longer the policy — they are a stale copy of one. Enforcing
    // them anyway would look like enforcement while checking a number the owner
    // has stopped maintaining, so this path closes instead. See
    // instructions/confidential.rs for the replacement.
    require!(
        !policy.has_confidential_limits(),
        PolicyError::ConfidentialLimitsRequired
    );
    require!(amount > 0, PolicyError::ZeroAmount);
    require!(
        amount <= policy.max_per_transfer,
        PolicyError::ExceedsPerTransferLimit
    );

    let now = Clock::get()?.unix_timestamp;
    let period_elapsed = now.saturating_sub(policy.period_start) >= policy.period_seconds;
    if period_elapsed {
        policy.spent_in_period = 0;
        policy.period_start = now;
    }

    let new_total = policy
        .spent_in_period
        .checked_add(amount)
        .ok_or(PolicyError::ExceedsPeriodLimit)?;
    require!(new_total <= policy.max_per_period, PolicyError::ExceedsPeriodLimit);

    policy.spent_in_period = new_total;
    Ok(())
}
