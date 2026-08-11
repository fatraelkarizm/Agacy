use anchor_lang::prelude::*;

use crate::{
    confidential_limits::{CiphertextBytes, ENCRYPTED_ZERO},
    constants::*,
    error::PolicyError,
    state::Policy,
};

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

/// Creates a policy whose limits have never existed on-chain in plaintext.
///
/// This is deliberately a separate instruction from `initialize` followed by
/// `set_confidential_limits`: even if the second transaction clears the
/// account, the first transaction and its historical account state remain
/// observable forever.
pub fn handle_initialize_confidential(
    ctx: Context<Initialize>,
    agent: Pubkey,
    limit_pubkey: [u8; 32],
    max_per_transfer_ct: CiphertextBytes,
    max_per_period_ct: CiphertextBytes,
    period_seconds: i64,
) -> Result<()> {
    require!(limit_pubkey != [0u8; 32], PolicyError::ProofUnderWrongKey);

    let policy = &mut ctx.accounts.policy;
    policy.owner = ctx.accounts.owner.key();
    policy.agent = agent;
    policy.max_per_transfer = 0;
    policy.max_per_period = 0;
    policy.period_seconds = period_seconds;
    policy.spent_in_period = 0;
    policy.period_start = Clock::get()?.unix_timestamp;
    policy.bump = ctx.bumps.policy;
    policy.custodied_token_account = Pubkey::default();
    policy.limit_pubkey = limit_pubkey;
    policy.max_per_transfer_ct = max_per_transfer_ct;
    policy.max_per_period_ct = max_per_period_ct;
    policy.spent_in_period_ct = ENCRYPTED_ZERO;
    Ok(())
}
