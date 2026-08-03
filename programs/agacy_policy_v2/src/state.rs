use anchor_lang::prelude::*;

/// Same policy math as the deployed native program (`program/src/lib.rs`),
/// reimplemented as a PDA so this program can sign for the account itself.
/// The first seven fields keep the native program's order and meaning so the
/// two can be compared directly by anyone auditing the migration.
///
/// `custodied_token_account` is the one addition, and it is the field that
/// distinguishes the two custody models this program supports:
///
/// - `Pubkey::default()` — delegate mode. The owner keeps ownership of the
///   token account and approves the policy PDA as its delegate. Works with
///   classic SPL Token; the owner can revoke at any time without this
///   program's cooperation.
/// - a real pubkey — custody mode. The policy PDA *is* the token account's
///   owner, which is the only arrangement Token-2022 confidential transfer
///   accepts (it ignores delegates entirely — confirmed on devnet, see
///   docs/PRIVACY_ARCHITECTURE.md §14.5). The owner's ability to walk away
///   unilaterally is gone, which is exactly why `release_custody` exists and
///   is not optional.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub max_per_transfer: u64,
    pub max_per_period: u64,
    pub period_seconds: i64,
    pub spent_in_period: u64,
    pub period_start: i64,
    pub bump: u8,
    /// `Pubkey::default()` means "no custody held" — see the type docs above.
    pub custodied_token_account: Pubkey,
}

impl Policy {
    pub fn holds_custody(&self) -> bool {
        self.custodied_token_account != Pubkey::default()
    }

    /// The seeds this program signs with, minus the bump. Kept here so the
    /// three call sites that need them cannot drift apart.
    pub fn signer_seeds<'a>(owner: &'a Pubkey, agent: &'a Pubkey) -> [&'a [u8]; 3] {
        [crate::constants::POLICY_SEED, owner.as_ref(), agent.as_ref()]
    }
}
