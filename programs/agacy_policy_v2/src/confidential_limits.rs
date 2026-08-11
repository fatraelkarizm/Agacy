//! Enforcing a spend limit the program itself is never allowed to learn.
//!
//! Everything else in this program compares two `u64`s. That works, but it
//! publishes the policy: anyone reading the account learns exactly how much
//! this agent may spend per transfer and per period. The payment *amounts* are
//! already hidden by Token-2022; the budget sitting next to them in plaintext
//! is the remaining leak, and it is a useful one to an attacker — it sizes the
//! target before they ever try anything.
//!
//! ## The idea
//!
//! Store the limits as ElGamal ciphertexts instead of integers, and never
//! compare them directly. ElGamal is additively homomorphic over Ristretto, so
//! the program can compute
//!
//! ```text
//! Enc(max_per_transfer) - Enc(amount) = Enc(max_per_transfer - amount)
//! ```
//!
//! without decrypting anything — it is two point subtractions. Then
//! `amount <= max_per_transfer` is exactly the statement "that difference is
//! non-negative", which is a *range proof*: prove the difference lies in
//! `[0, 2^32)`. If the agent asked for more than its limit, the difference is
//! a negative number, which in the scalar field is an enormous value that no
//! 32-bit range proof can cover. There is nothing to fake — a false statement
//! simply has no proof.
//!
//! The period budget works the same way, and better: `spent + amount` is
//! another homomorphic addition, so the running total stays encrypted too.
//!
//! ## What this program does and does not do
//!
//! It does **not** verify any proof. Solana already ships a deployed, audited
//! ZK ElGamal Proof program that does, writing its verified result into a
//! *context state account*. This module's job is to check that the context
//! accounts it was handed really are that program's output and really describe
//! the statement we needed proved. That check is three parts, and all three
//! matter:
//!
//! 1. **the account is owned by the ZK ElGamal Proof program** — without this
//!    the entire scheme is theatre, because anyone can create an account and
//!    write whatever "proof context" bytes they like into it;
//! 2. **the proof type byte matches** — a validity proof is not a range proof,
//!    and accepting one where the other was required proves nothing;
//! 3. **the context describes our statement** — the ciphertext in the equality
//!    context must equal the difference *this program just computed on-chain*,
//!    not one the caller supplied, and the commitment it binds to must be the
//!    one the range proof covers.
//!
//! Break any link in that chain and a proof about some unrelated numbers would
//! be accepted as a proof about these ones.
//!
//! ## Honest boundaries
//!
//! - **Hidden from the public, not from the agent.** Producing the equality
//!   proof requires the ElGamal secret key, so whoever proves can also decrypt.
//!   The agent holding it is not a leak in this design — an agent needs to know
//!   its own budget to plan against it. What changes is that a block explorer
//!   no longer does.
//! - **Holding the key grants no forgery.** The key lets its holder prove true
//!   statements. It does not let them prove `amount <= limit` when that is
//!   false; the range proof is what refuses, and it refuses regardless of who
//!   holds what.
//! - **This does not close §14.3.** Binding the *claimed* amount ciphertext to
//!   the amount a confidential transfer actually moves is a different, still
//!   open problem. Nothing here addresses it.
//! - **Differences must fit in 32 bits** (see `RANGE_BIT_LENGTH`) — about 4,295
//!   tokens at 6 decimals. A batched 64-bit range proof covers both statements
//!   in one proof by splitting its budget 32/32, which is what keeps this to
//!   three proof accounts instead of four.

use anchor_lang::prelude::*;
use solana_curve25519::{
    ristretto::{add_ristretto, multiply_ristretto, subtract_ristretto, PodRistrettoPoint},
    scalar::PodScalar,
};

use crate::error::PolicyError;

/// Solana's deployed proof verifier. Every context account this module trusts
/// must be owned by it — see point 1 in the module docs.
pub const ZK_ELGAMAL_PROOF_PROGRAM_ID: Pubkey = pubkey!("ZkE1Gama1Proof11111111111111111111111111111");

/// Discriminants from `solana_zk_sdk::zk_elgamal_proof_program::proof_data::ProofType`,
/// which is an ordinary `enum` numbered from zero. Read out of the crate
/// source rather than guessed, because accepting the wrong proof type is a
/// silent hole rather than a visible failure.
pub const PROOF_TYPE_CIPHERTEXT_COMMITMENT_EQUALITY: u8 = 3;
pub const PROOF_TYPE_BATCHED_RANGE_PROOF_U64: u8 = 6;
pub const PROOF_TYPE_BATCHED_GROUPED_CIPHERTEXT_3_HANDLES_VALIDITY: u8 = 12;

/// `ProofContextState`: authority(32) | proof_type(1) | context.
const CONTEXT_AUTHORITY_LEN: usize = 32;
const CONTEXT_HEADER_LEN: usize = CONTEXT_AUTHORITY_LEN + 1;

/// `CiphertextCommitmentEqualityProofContext`: pubkey(32) | ciphertext(64) | commitment(32).
const EQUALITY_CONTEXT_LEN: usize = 32 + 64 + 32;
const EQUALITY_ACCOUNT_LEN: usize = CONTEXT_HEADER_LEN + EQUALITY_CONTEXT_LEN;

/// `BatchedRangeProofContext`: commitments[8](32 each) | bit_lengths[8].
const MAX_COMMITMENTS: usize = 8;
const RANGE_CONTEXT_LEN: usize = MAX_COMMITMENTS * 32 + MAX_COMMITMENTS;
const RANGE_ACCOUNT_LEN: usize = CONTEXT_HEADER_LEN + RANGE_CONTEXT_LEN;

/// `BatchedGroupedCiphertext3HandlesValidityProofContext`:
/// three pubkeys followed by two grouped ciphertexts. Each grouped ciphertext
/// is commitment(32) | source handle(32) | destination handle(32) | auditor handle(32).
const TRANSFER_VALIDITY_CONTEXT_LEN: usize = 32 * 3 + 128 * 2;
const TRANSFER_VALIDITY_ACCOUNT_LEN: usize = CONTEXT_HEADER_LEN + TRANSFER_VALIDITY_CONTEXT_LEN;
const GROUPED_LO_AT: usize = CONTEXT_HEADER_LEN + 32 * 3;
const GROUPED_HI_AT: usize = GROUPED_LO_AT + 128;
const SOURCE_HANDLE_AT: usize = 32;
const TRANSFER_AMOUNT_LO_BITS: usize = 16;

/// Each of the two differences gets half of the batched proof's 64-bit budget.
///
/// This is a **security parameter, not a batching convenience**, and the
/// difference was confirmed by trying it rather than reasoned about: a
/// negative difference wraps to roughly `2^64 - n` in the scalar field, and
/// that value is still inside `[0, 2^64)`. A 64-bit range proof over it
/// therefore *succeeds* and proves nothing at all — an over-limit spend would
/// sail through. At 32 bits the wrapped value is far outside the range and no
/// proof exists, which is the property this whole scheme rests on.
///
/// The cost is a documented ceiling: every difference must fit in 32 bits,
/// about 4,295 tokens at 6 decimals.
pub const RANGE_BIT_LENGTH: u8 = 32;

pub const CIPHERTEXT_LEN: usize = 64;
pub type CiphertextBytes = [u8; CIPHERTEXT_LEN];
pub type CommitmentBytes = [u8; 32];

/// An ElGamal ciphertext is two compressed Ristretto points laid out back to
/// back — the Pedersen commitment `C = v·G + r·H`, then the decrypt handle
/// `D = r·P`. Both halves are additively homomorphic, so combining two
/// ciphertexts is just combining each half pointwise. The client does the
/// identical arithmetic in `server/data/elgamal-arithmetic.ts`; the two must
/// agree exactly or the equality proof will not match.
fn combine(left: &CiphertextBytes, right: &CiphertextBytes, add: bool) -> Result<CiphertextBytes> {
    let mut out = [0u8; CIPHERTEXT_LEN];
    for half in 0..2 {
        let start = half * 32;
        let a = PodRistrettoPoint(slice32(left, start));
        let b = PodRistrettoPoint(slice32(right, start));
        let combined = if add {
            add_ristretto(&a, &b)
        } else {
            subtract_ristretto(&a, &b)
        }
        .ok_or(PolicyError::InvalidCiphertext)?;
        out[start..start + 32].copy_from_slice(&combined.0);
    }
    Ok(out)
}

pub fn subtract_ciphertexts(left: &CiphertextBytes, right: &CiphertextBytes) -> Result<CiphertextBytes> {
    combine(left, right, false)
}

pub fn add_ciphertexts(left: &CiphertextBytes, right: &CiphertextBytes) -> Result<CiphertextBytes> {
    combine(left, right, true)
}

fn scale_ciphertext(value: &CiphertextBytes, scalar: &PodScalar) -> Result<CiphertextBytes> {
    let mut out = [0u8; CIPHERTEXT_LEN];
    for half in 0..2 {
        let start = half * 32;
        let point = PodRistrettoPoint(slice32(value, start));
        let scaled = multiply_ristretto(scalar, &point).ok_or(PolicyError::InvalidCiphertext)?;
        out[start..start + 32].copy_from_slice(&scaled.0);
    }
    Ok(out)
}

fn slice32(bytes: &[u8], start: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[start..start + 32]);
    out
}

/// A verified `CiphertextCommitmentEquality` context, read out of an account
/// the ZK ElGamal Proof program wrote.
pub struct EqualityContext {
    pub pubkey: [u8; 32],
    pub ciphertext: CiphertextBytes,
    pub commitment: CommitmentBytes,
}

fn read_context_bytes(account: &AccountInfo, expected_type: u8, expected_len: usize) -> Result<Vec<u8>> {
    // Point 1 from the module docs, and the one that carries all the weight:
    // without this, a caller fabricates an account containing whatever context
    // they wish and every other check below passes happily.
    require_keys_eq!(
        *account.owner,
        ZK_ELGAMAL_PROOF_PROGRAM_ID,
        PolicyError::ProofAccountNotFromVerifier
    );

    let data = account.try_borrow_data()?;
    require!(data.len() >= expected_len, PolicyError::MalformedProofContext);
    require!(
        data[CONTEXT_AUTHORITY_LEN] == expected_type,
        PolicyError::WrongProofType
    );
    Ok(data[..expected_len].to_vec())
}

pub fn read_equality_context(account: &AccountInfo) -> Result<EqualityContext> {
    let data = read_context_bytes(
        account,
        PROOF_TYPE_CIPHERTEXT_COMMITMENT_EQUALITY,
        EQUALITY_ACCOUNT_LEN,
    )?;

    let mut ciphertext = [0u8; CIPHERTEXT_LEN];
    ciphertext.copy_from_slice(&data[CONTEXT_HEADER_LEN + 32..CONTEXT_HEADER_LEN + 96]);

    Ok(EqualityContext {
        pubkey: slice32(&data, CONTEXT_HEADER_LEN),
        ciphertext,
        commitment: slice32(&data, CONTEXT_HEADER_LEN + 96),
    })
}

/// Derive the exact amount ciphertext Token-2022 will consume from its already
/// verified transfer-validity context. The source handle is used because a
/// policy is keyed to the custodied source account's ElGamal key.
pub fn read_transfer_amount_ciphertext(
    account: &AccountInfo,
    expected_source_pubkey: &[u8; 32],
) -> Result<CiphertextBytes> {
    let data = read_context_bytes(
        account,
        PROOF_TYPE_BATCHED_GROUPED_CIPHERTEXT_3_HANDLES_VALIDITY,
        TRANSFER_VALIDITY_ACCOUNT_LEN,
    )?;
    require!(
        slice32(&data, CONTEXT_HEADER_LEN) == *expected_source_pubkey,
        PolicyError::ProofUnderWrongKey
    );

    let grouped_ciphertext = |start: usize| {
        let mut ciphertext = [0u8; CIPHERTEXT_LEN];
        ciphertext[..32].copy_from_slice(&data[start..start + 32]);
        ciphertext[32..].copy_from_slice(
            &data[start + SOURCE_HANDLE_AT..start + SOURCE_HANDLE_AT + 32],
        );
        ciphertext
    };
    let lo = grouped_ciphertext(GROUPED_LO_AT);
    let hi = grouped_ciphertext(GROUPED_HI_AT);
    let mut weight_bytes = [0u8; 32];
    weight_bytes[TRANSFER_AMOUNT_LO_BITS / 8] = 1;
    let weighted_hi = scale_ciphertext(&hi, &PodScalar(weight_bytes))?;
    add_ciphertexts(&lo, &weighted_hi)
}

/// Confirms the batched range proof covers exactly the two commitments given,
/// in order, each over 32 bits — and nothing else.
///
/// The trailing slots are required to be empty rather than ignored. An
/// all-zero commitment is rejected outright when a proof is created, so a zero
/// slot unambiguously means "unused"; insisting on that removes any question
/// about what an extra commitment might have smuggled in.
pub fn verify_range_context(
    account: &AccountInfo,
    first: &CommitmentBytes,
    second: &CommitmentBytes,
) -> Result<()> {
    let data = read_context_bytes(account, PROOF_TYPE_BATCHED_RANGE_PROOF_U64, RANGE_ACCOUNT_LEN)?;
    let bit_lengths_at = CONTEXT_HEADER_LEN + MAX_COMMITMENTS * 32;

    require!(
        slice32(&data, CONTEXT_HEADER_LEN) == *first
            && slice32(&data, CONTEXT_HEADER_LEN + 32) == *second,
        PolicyError::ProofDoesNotCoverThisStatement
    );
    require!(
        data[bit_lengths_at] == RANGE_BIT_LENGTH && data[bit_lengths_at + 1] == RANGE_BIT_LENGTH,
        PolicyError::ProofDoesNotCoverThisStatement
    );

    for slot in 2..MAX_COMMITMENTS {
        require!(
            slice32(&data, CONTEXT_HEADER_LEN + slot * 32) == [0u8; 32]
                && data[bit_lengths_at + slot] == 0,
            PolicyError::ProofDoesNotCoverThisStatement
        );
    }

    Ok(())
}

/// Ties one equality context to a difference this program computed itself.
///
/// `expected_ciphertext` is never taken from the caller — it is the result of
/// on-chain homomorphic arithmetic over the stored limit. That is the whole
/// point: the proof is forced to be about our number, not the prover's.
pub fn require_equality_over(
    context: &EqualityContext,
    expected_pubkey: &[u8; 32],
    expected_ciphertext: &CiphertextBytes,
) -> Result<()> {
    require!(
        context.pubkey == *expected_pubkey,
        PolicyError::ProofUnderWrongKey
    );
    require!(
        context.ciphertext == *expected_ciphertext,
        PolicyError::ProofDoesNotCoverThisStatement
    );
    Ok(())
}

/// The canonical encoding of the Ristretto identity is 32 zero bytes, so an
/// all-zero ciphertext is `(0·G + 0·H, 0·P)` — a perfectly ordinary encryption
/// of zero with zero randomness. That is what lets the program reset a spent
/// total on period rollover without needing a key or any randomness of its own.
pub const ENCRYPTED_ZERO: CiphertextBytes = [0u8; CIPHERTEXT_LEN];

#[cfg(test)]
mod tests {
    use super::*;

    /// Ristretto's basepoint, so the tests operate on a real curve point
    /// rather than only on the identity.
    fn basepoint() -> [u8; 32] {
        // Compressed encoding of the Ristretto basepoint (RFC 9496 §A.1).
        [
            0xe2, 0xf2, 0xae, 0x0a, 0x6a, 0xbc, 0x4e, 0x71, 0xa8, 0x84, 0xa9, 0x61, 0xc5, 0x00,
            0x51, 0x5f, 0x58, 0xe3, 0x0b, 0x6a, 0xa5, 0x82, 0xdd, 0x8d, 0xb6, 0xa6, 0x54, 0x45,
            0xe3, 0x8d, 0xf3, 0x76,
        ]
    }

    fn ciphertext(commitment: [u8; 32], handle: [u8; 32]) -> CiphertextBytes {
        let mut out = [0u8; CIPHERTEXT_LEN];
        out[..32].copy_from_slice(&commitment);
        out[32..].copy_from_slice(&handle);
        out
    }

    #[test]
    fn subtracting_a_ciphertext_from_itself_gives_the_encryption_of_zero() {
        let value = ciphertext(basepoint(), basepoint());
        assert_eq!(subtract_ciphertexts(&value, &value).unwrap(), ENCRYPTED_ZERO);
    }

    #[test]
    fn adding_the_encryption_of_zero_changes_nothing() {
        let value = ciphertext(basepoint(), basepoint());
        assert_eq!(add_ciphertexts(&value, &ENCRYPTED_ZERO).unwrap(), value);
    }

    /// The property the period accumulator depends on: subtracting back out
    /// what was added returns the original, so `spent` can grow homomorphically
    /// without ever being decrypted.
    #[test]
    fn addition_and_subtraction_are_inverses() {
        let a = ciphertext(basepoint(), basepoint());
        let b = ciphertext(basepoint(), [0u8; 32]);
        let sum = add_ciphertexts(&a, &b).unwrap();
        assert_eq!(subtract_ciphertexts(&sum, &b).unwrap(), a);
    }

    #[test]
    fn the_all_zero_ciphertext_really_is_a_valid_point_pair() {
        // If the identity were rejected by the curve syscalls, resetting a
        // spent total on rollover would fail at runtime rather than here.
        assert_eq!(
            add_ciphertexts(&ENCRYPTED_ZERO, &ENCRYPTED_ZERO).unwrap(),
            ENCRYPTED_ZERO
        );
    }

    #[test]
    fn garbage_bytes_are_rejected_rather_than_silently_combined() {
        let invalid = ciphertext([0xff; 32], [0xff; 32]);
        let valid = ciphertext(basepoint(), basepoint());
        assert!(subtract_ciphertexts(&valid, &invalid).is_err());
    }

    #[test]
    fn derives_the_source_amount_from_a_verified_transfer_context() {
        let source_pubkey = basepoint();
        let mut data = vec![0u8; TRANSFER_VALIDITY_ACCOUNT_LEN];
        data[CONTEXT_AUTHORITY_LEN] =
            PROOF_TYPE_BATCHED_GROUPED_CIPHERTEXT_3_HANDLES_VALIDITY;
        data[CONTEXT_HEADER_LEN..CONTEXT_HEADER_LEN + 32].copy_from_slice(&source_pubkey);
        data[GROUPED_LO_AT..GROUPED_LO_AT + 32].copy_from_slice(&basepoint());
        data[GROUPED_LO_AT + SOURCE_HANDLE_AT..GROUPED_LO_AT + SOURCE_HANDLE_AT + 32]
            .copy_from_slice(&basepoint());

        let key = Pubkey::new_unique();
        let mut lamports = 0;
        let account = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &ZK_ELGAMAL_PROOF_PROGRAM_ID,
            false,
        );

        assert_eq!(
            read_transfer_amount_ciphertext(&account, &source_pubkey).unwrap(),
            ciphertext(basepoint(), basepoint())
        );
        assert!(read_transfer_amount_ciphertext(&account, &[9u8; 32]).is_err());
    }
}
