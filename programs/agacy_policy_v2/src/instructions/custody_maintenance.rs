use anchor_lang::prelude::*;

use crate::{
    custody_guard::{classify_cpi, CpiKind},
    error::PolicyError,
    instructions::authorize_and_invoke::{forward_as_policy_pda, require_custodied_source},
    state::Policy,
};

/// The non-spending half of custody.
///
/// Token-2022 credits an incoming confidential transfer to the recipient's
/// *pending* balance, and only the account's own authority can move it into
/// the available balance via `ApplyPendingBalance`. Once the policy PDA owns
/// the account, that authority is the PDA — so without a path to call it, an
/// agent's received funds accumulate in pending and are unusable until the
/// owner takes the account back entirely. That would be a functional dead end
/// created purely by the custody model, so it gets a real instruction.
///
/// Kept separate from `authorize_and_invoke` rather than folded into it,
/// because the two have opposite budget semantics: this instruction must not
/// consume any spend allowance. `ApplyPendingBalance` moves nothing out of the
/// account — charging a period budget for it would let an agent's own incoming
/// payments silently eat the allowance it needs to make outgoing ones. The
/// split is enforced from both sides: `classify_cpi` must return `Maintenance`
/// here and `Spend` there, so no instruction is ever reachable through both.
#[derive(Accounts)]
pub struct CustodyMaintenance<'info> {
    #[account(has_one = agent @ PolicyError::IllegalSigner)]
    pub policy: Account<'info, Policy>,
    pub agent: Signer<'info>,
    /// CHECK: forwarded verbatim as the CPI's program id, and required by
    /// `classify_cpi` to be SPL Token or Token-2022.
    pub target_program: UncheckedAccount<'info>,
}

pub fn handle_custody_maintenance(
    ctx: Context<CustodyMaintenance>,
    instruction_data: Vec<u8>,
) -> Result<()> {
    let kind = classify_cpi(ctx.accounts.target_program.key, &instruction_data)?;
    require!(
        kind == CpiKind::Maintenance,
        PolicyError::NotAMaintenanceInstruction
    );
    require_custodied_source(&ctx.accounts.policy, ctx.remaining_accounts)?;

    let policy_key = ctx.accounts.policy.key();
    forward_as_policy_pda(
        &ctx.accounts.policy,
        policy_key,
        ctx.accounts.target_program.key,
        instruction_data,
        ctx.remaining_accounts,
    )
}
