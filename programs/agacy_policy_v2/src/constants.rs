use anchor_lang::prelude::*;

/// Seed prefix for the policy PDA: `[POLICY_SEED, owner, agent]`.
///
/// Deriving the account this way — instead of accepting an arbitrary
/// keypair-created account, as the original native `program/` does — is what
/// lets this program sign for the account via `invoke_signed` later, which is
/// the prerequisite for CPI-ing into a token transfer as the delegate. See
/// docs/PRIVACY_ARCHITECTURE.md section 14 for the full design and its
/// honestly-documented limits (this closes the *structural* bypass, not the
/// confidential-amount-claim bypass).
#[constant]
pub const POLICY_SEED: &[u8] = b"policy";
