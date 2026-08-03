use anchor_lang::prelude::*;

use crate::{constants::*, state::Policy};

/// accounts: policy PDA (created here), owner (signer, pays rent).
/// `agent` is passed as an instruction argument (not an account) because it
/// only needs to be a pubkey for seed derivation and storage — it never signs
/// this instruction.
#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, owner.key().as_ref(), agent.as_ref()],
        bump
    )]
    pub policy: Account<'info, Policy>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    agent: Pubkey,
    max_per_transfer: u64,
    max_per_period: u64,
    period_seconds: i64,
) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    policy.owner = ctx.accounts.owner.key();
    policy.agent = agent;
    policy.max_per_transfer = max_per_transfer;
    policy.max_per_period = max_per_period;
    policy.period_seconds = period_seconds;
    policy.spent_in_period = 0;
    policy.period_start = Clock::get()?.unix_timestamp;
    policy.bump = ctx.bumps.policy;
    // A fresh policy holds nothing. Written explicitly rather than relying on
    // `init` zeroing the account, so the "no custody" state is a stated
    // invariant of this handler and not an accident of allocation.
    policy.custodied_token_account = Pubkey::default();
    Ok(())
}
