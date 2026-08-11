//! PDA-based rewrite of the deployed native spend-policy program
//! (`program/src/lib.rs`), written to make the spend limit binding rather
//! than advisory.
//!
//! The native program's `authorize` instruction only *records* that a
//! claimed amount is within policy — nothing stops an agent that holds the
//! token account's own authority from skipping this program entirely and
//! calling Token-2022 directly. Making the policy account a PDA (seeds
//! `[POLICY_SEED, owner, agent]`, see constants.rs) lets this program sign
//! for the account itself via `invoke_signed`, which is what makes the token
//! account answer to the policy instead of to the agent.
//!
//! Two arrangements are supported, and the difference matters:
//!
//! - **Delegate** — the owner approves the policy PDA as an SPL delegate and
//!   keeps ownership. Proven against classic SPL Token on live devnet. It
//!   does not work for Token-2022 confidential transfer, which ignores
//!   delegates outright (`OwnerMismatch`, confirmed on devnet).
//! - **Custody** — `assume_custody` makes the policy PDA the token account's
//!   actual owner, which is the only arrangement confidential transfer
//!   accepts. This is strictly more powerful and strictly more dangerous, so
//!   it ships with two things that are not optional: `release_custody` (an
//!   unconditional, owner-only way back out — see instructions/custody.rs)
//!   and `custody_guard.rs` (a hard allowlist on what the PDA's signature can
//!   ever authorize).
//!
//! Confidential payments additionally derive their policy amount from the
//! exact verifier-owned Token-2022 validity context consumed by the CPI. No
//! separate caller-supplied amount claim exists on that path.

pub mod confidential_limits;
pub mod constants;
pub mod custody_guard;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

// Redeployed under a new id when custody landed. The previous deployment
// (`783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G`) is still live and still
// delegate-only; it was left in place rather than upgraded because its
// upgrade authority is not a key this project holds. Policy accounts created
// against the old id also predate the `custodied_token_account` field and
// would not deserialize here, so a clean id is the honest boundary.
declare_id!("9sYKkYh1GTKY2whkGPGXuG1VKiYqfiwyjVcpQbYtHtwW");

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

    /// Creates a confidential policy atomically. Unlike `initialize` followed
    /// by `set_confidential_limits`, no transaction or account state ever
    /// contains the plaintext limits.
    pub fn initialize_confidential(
        ctx: Context<Initialize>,
        agent: Pubkey,
        limit_pubkey: [u8; 32],
        max_per_transfer_ct: [u8; 64],
        max_per_period_ct: [u8; 64],
        period_seconds: i64,
    ) -> Result<()> {
        crate::instructions::initialize::handle_initialize_confidential(
            ctx,
            agent,
            limit_pubkey,
            max_per_transfer_ct,
            max_per_period_ct,
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
    /// PDA itself. Only transfer instructions on SPL Token or Token-2022 are
    /// forwardable — see custody_guard.rs for why that restriction is what
    /// makes custody survivable at all.
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

    /// Owner hands the token account's ownership to the policy PDA. Required
    /// for Token-2022 confidential transfer, which does not accept delegates.
    pub fn assume_custody(ctx: Context<AssumeCustody>) -> Result<()> {
        crate::instructions::custody::handle_assume_custody(ctx)
    }

    /// The recovery hatch. Owner-only, unconditional, and deliberately
    /// unaffected by the spend budget, the period clock, or anything the
    /// agent has done. Read instructions/custody.rs before changing anything
    /// about this instruction — it is the only thing standing between a bug
    /// in this program and permanently stranded funds.
    pub fn release_custody(ctx: Context<ReleaseCustody>, new_authority: Pubkey) -> Result<()> {
        crate::instructions::custody::handle_release_custody(ctx, new_authority)
    }

    /// Replace this policy's visible limits with ElGamal ciphertexts, so the
    /// budget stops being public. Owner-only. See confidential_limits.rs.
    pub fn set_confidential_limits(
        ctx: Context<SetConfidentialLimits>,
        limit_pubkey: [u8; 32],
        max_per_transfer_ct: [u8; 64],
        max_per_period_ct: [u8; 64],
    ) -> Result<()> {
        crate::instructions::confidential::handle_set_confidential_limits(
            ctx,
            limit_pubkey,
            max_per_transfer_ct,
            max_per_period_ct,
        )
    }

    /// Check a spend against encrypted limits, without ever learning either the
    /// limits or the amount.
    pub fn authorize_confidential(
        ctx: Context<AuthorizeConfidential>,
        amount_ct: [u8; 64],
    ) -> Result<()> {
        crate::instructions::confidential::handle_authorize_confidential(ctx, amount_ct)
    }

    /// The confidential twin of `authorize_and_invoke` — same CPI allowlist and
    /// custody rules, budget enforced over ciphertexts.
    pub fn authorize_confidential_and_invoke(
        ctx: Context<AuthorizeConfidentialAndInvoke>,
        instruction_data: Vec<u8>,
    ) -> Result<()> {
        crate::instructions::confidential::handle_authorize_confidential_and_invoke(
            ctx,
            instruction_data,
        )
    }

    /// Non-spending upkeep on a custodied account (`ApplyPendingBalance`).
    /// Charges no policy budget, and cannot reach any instruction that moves
    /// funds out — see instructions/custody_maintenance.rs.
    pub fn custody_maintenance(
        ctx: Context<CustodyMaintenance>,
        instruction_data: Vec<u8>,
    ) -> Result<()> {
        crate::instructions::custody_maintenance::handle_custody_maintenance(ctx, instruction_data)
    }
}
