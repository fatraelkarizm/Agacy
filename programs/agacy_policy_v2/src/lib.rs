//! PDA-based rewrite of the deployed native spend-policy program
//! (`program/src/lib.rs`), written to make delegate binding possible.
//!
//! The native program's `authorize` instruction only *records* that a
//! claimed amount is within policy — nothing stops an agent that holds the
//! token account's own authority from skipping this program entirely and
//! calling Token-2022 directly. Making the policy account a PDA (seeds
//! `[POLICY_SEED, owner, agent]`, see constants.rs) means this program can
//! sign for it via `invoke_signed`, which is the prerequisite for becoming
//! the token account's actual delegate and CPI-ing the transfer itself —
//! that CPI wiring is designed but not implemented here; see
//! docs/PRIVACY_ARCHITECTURE.md section 14 for exactly what this does and
//! does not close, and why.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G");

#[program]
pub mod agacy_policy_v2 {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        agent: Pubkey,
        max_per_transfer: u64,
        max_per_period: u64,
        period_seconds: i64,
    ) -> Result<()> {
        crate::instructions::initialize::handle_initialize(
            ctx,
            agent,
            max_per_transfer,
            max_per_period,
            period_seconds,
        )
    }

    pub fn update_limits(
        ctx: Context<UpdateLimits>,
        max_per_transfer: u64,
        max_per_period: u64,
    ) -> Result<()> {
        crate::instructions::update_limits::handle_update_limits(
            ctx,
            max_per_transfer,
            max_per_period,
        )
    }

    pub fn authorize(ctx: Context<Authorize>, amount: u64) -> Result<()> {
        crate::instructions::authorize::handle_authorize(ctx, amount)
    }

    /// Policy-gated CPI: checks policy, then forwards `instruction_data` to
    /// `target_program` with `ctx.remaining_accounts`, signing for the policy
    /// PDA itself. See authorize_and_invoke.rs for exactly what this does and
    /// does not prove.
    pub fn authorize_and_invoke(
        ctx: Context<AuthorizeAndInvoke>,
        amount: u64,
        instruction_data: Vec<u8>,
    ) -> Result<()> {
        crate::instructions::authorize_and_invoke::handle_authorize_and_invoke(
            ctx,
            amount,
            instruction_data,
        )
    }
}
