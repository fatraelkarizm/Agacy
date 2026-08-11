use anchor_lang::prelude::*;

use crate::{error::PolicyError, state::Policy};

/// Owner-only, same as the native program: the agent must never be able to
/// raise its own ceiling, which is the entire point of keeping owner and
/// agent as separate signer roles.
#[derive(Accounts)]
pub struct UpdateLimits<'info> {
    #[account(mut, has_one = owner @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub owner: Signer<'info>,
}

pub fn handle_update_limits(
    ctx: Context<UpdateLimits>,
    max_per_transfer: u64,
    max_per_period: u64,
) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    require!(
        !policy.has_confidential_limits(),
        PolicyError::ConfidentialLimitsRequired
    );
    policy.max_per_transfer = max_per_transfer;
    policy.max_per_period = max_per_period;
    Ok(())
}
