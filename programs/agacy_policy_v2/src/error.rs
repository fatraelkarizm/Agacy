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
    #[msg("This policy already holds custody of a token account")]
    CustodyAlreadyHeld,
    #[msg("This policy does not hold custody of the given token account")]
    NoCustodyHeld,
    #[msg("This program will only sign CPIs into SPL Token or Token-2022")]
    ForbiddenCpiProgram,
    #[msg("This program will not sign that instruction - only transfers and apply-pending-balance are forwardable")]
    ForbiddenCpiInstruction,
    #[msg("A custodied policy may only move funds out of the account it custodies")]
    CpiSourceMismatch,
    #[msg("The forwarded instruction is missing its source account")]
    MissingCpiAccounts,
    #[msg("That instruction spends funds and must go through authorize_and_invoke")]
    NotAMaintenanceInstruction,
    #[msg("That instruction does not spend funds and must not consume policy budget")]
    NotASpendInstruction,
    #[msg("Ciphertext bytes are not a valid Ristretto point pair")]
    InvalidCiphertext,
    #[msg("Proof context account is not owned by the ZK ElGamal Proof program")]
    ProofAccountNotFromVerifier,
    #[msg("Proof context account is too small to hold the expected context")]
    MalformedProofContext,
    #[msg("Proof context is of the wrong proof type for this check")]
    WrongProofType,
    #[msg("Proof was produced under a different ElGamal key than this policy's")]
    ProofUnderWrongKey,
    #[msg("Proof does not cover the statement this program needed proved")]
    ProofDoesNotCoverThisStatement,
    #[msg("This policy has no confidential limits configured")]
    NoConfidentialLimits,
    #[msg("This policy enforces confidential limits — use the confidential authorization path")]
    ConfidentialLimitsRequired,
}
