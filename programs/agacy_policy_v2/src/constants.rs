use anchor_lang::prelude::*;

/// Seed prefix for the policy PDA: `[POLICY_SEED, owner, agent]`.
///
/// Deriving the account this way — instead of accepting an arbitrary
/// keypair-created account, as the original native `program/` does — is what
/// lets this program sign for the account via `invoke_signed` later, which is
/// the prerequisite for CPI-ing into a token transfer as the delegate. See
/// docs/PRIVACY_ARCHITECTURE.md section 14 for the full design and its
/// honestly-documented limits.
#[constant]
pub const POLICY_SEED: &[u8] = b"policy";

/// The only two programs this program will ever sign a CPI for.
///
/// Both addresses have been fixed since their respective launches. The
/// allowlist is what keeps the policy PDA's signing authority narrow — see
/// `custody_guard.rs` for why an unrestricted `invoke_signed` becomes a total
/// custody escape the moment the PDA *owns* the token account rather than
/// merely being its delegate.
pub const SPL_TOKEN_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// SPL Token / Token-2022 instruction tags (first byte of instruction data).
pub mod token_ix {
    pub const TRANSFER: u8 = 3;
    pub const SET_AUTHORITY: u8 = 6;
    pub const TRANSFER_CHECKED: u8 = 12;
    /// Token-2022 only: the confidential-transfer extension, whose own
    /// sub-instruction tag follows in the next byte.
    pub const CONFIDENTIAL_TRANSFER_EXTENSION: u8 = 27;
}

/// Sub-instruction tags carried in the byte after
/// `token_ix::CONFIDENTIAL_TRANSFER_EXTENSION`.
pub mod confidential_ix {
    pub const DEPOSIT: u8 = 5;
    /// Deliberately absent from every allowlist: `Withdraw` (6) moves value
    /// from an account's confidential balance to its public one. Nothing
    /// leaves the account, so it is not a spend — but it destroys the privacy
    /// the account exists for, and an agent should not be able to do that to
    /// its owner unilaterally. The owner can always `release_custody` first.
    pub const TRANSFER: u8 = 7;
    pub const APPLY_PENDING_BALANCE: u8 = 8;
    pub const TRANSFER_WITH_FEE: u8 = 13;
}

/// `AuthorityType::AccountOwner` — the discriminant `SetAuthority` uses to
/// change who owns a token account. Handing this to the policy PDA is what
/// custody *is*; handing it back is what `release_custody` does.
pub const AUTHORITY_TYPE_ACCOUNT_OWNER: u8 = 2;
