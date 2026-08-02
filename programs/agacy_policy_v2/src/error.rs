use anchor_lang::prelude::*;

#[error_code]
pub enum PolicyError {
    #[msg("Transfer amount must be greater than zero")]
    ZeroAmount,
    #[msg("Transfer exceeds the per-transfer limit")]
    ExceedsPerTransferLimit,
    #[msg("Transfer would exceed the period limit")]
    ExceedsPeriodLimit,
    #[msg("Signer is not authorized for this policy")]
    IllegalSigner,
}
