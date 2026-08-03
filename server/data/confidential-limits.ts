import {
  BatchedRangeProofU64Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalKeypair,
  PedersenCommitment,
  PedersenOpening,
} from "@solana/zk-sdk/node";
import { subtractCiphertexts, addCiphertexts } from "./elgamal-arithmetic.js";

/**
 * The proving side of confidential spend limits.
 *
 * The program (`programs/agacy_policy_v2/src/confidential_limits.rs`) can only
 * do two things with an encrypted limit: combine ciphertexts homomorphically,
 * and check that somebody has already proved a statement about the result. This
 * module produces those proofs.
 *
 * Two statements are proved on every authorization:
 *
 *   `max_per_transfer - amount >= 0`
 *   `max_per_period - (spent + amount) >= 0`
 *
 * Each is proved in two parts, because no single available proof type says all
 * of it. A `CiphertextCommitmentEquality` proof binds a Pedersen commitment to
 * the difference *ciphertext the program computes on-chain* — that is what stops
 * a prover from answering a different question than the one asked. A batched
 * range proof then shows both committed values lie in `[0, 2^32)`, which is the
 * "non-negative" part. Neither half is sufficient alone; the program checks that
 * the same commitments appear in both.
 *
 * ## Why 32 bits, and why that is not negotiable
 *
 * A negative difference does not stay negative — it wraps to roughly `2^64 - n`
 * in the scalar field. That value is still inside `[0, 2^64)`, so a *64-bit*
 * range proof over an over-limit spend succeeds and proves nothing whatsoever.
 * Confirmed by generating one rather than by reasoning about it. At 32 bits the
 * wrapped value is nowhere near the range and no proof can be produced, which is
 * the entire security argument. The cost is a ceiling: differences must fit in
 * 32 bits, roughly 4,295 tokens at 6 decimals.
 *
 * ## Ordering constraints from the wasm bindings
 *
 * `BatchedRangeProofU64Data` takes ownership of the `PedersenCommitment` and
 * `PedersenOpening` objects handed to it — touching them afterwards throws
 * "null pointer passed to rust". So every byte needed from them is captured
 * first, and the range proof is always constructed last. This is a real
 * constraint of the bindings, not a style choice.
 */

/** Bit budget per statement. Must match `RANGE_BIT_LENGTH` in the program. */
export const RANGE_BIT_LENGTH = 32;

/** Largest difference a 32-bit range proof can cover. */
export const MAX_PROVABLE_DIFFERENCE = 2n ** 32n - 1n;

export interface ConfidentialLimitState {
  /** `Enc(max_per_transfer)` as stored on-chain. */
  readonly maxPerTransferCt: Uint8Array;
  /** `Enc(max_per_period)` as stored on-chain. */
  readonly maxPerPeriodCt: Uint8Array;
  /** `Enc(spent_in_period)` as stored on-chain. */
  readonly spentInPeriodCt: Uint8Array;
}

export interface ConfidentialLimitValues {
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly spentInPeriod: bigint;
}

export interface ConfidentialAuthorization {
  /** `Enc(amount)`, handed to the program as instruction data. */
  readonly amountCiphertext: Uint8Array;
  /** Proof payloads, each to be verified into its own context account. */
  readonly transferEqualityProof: Uint8Array;
  readonly periodEqualityProof: Uint8Array;
  readonly rangeProof: Uint8Array;
}

/**
 * Encrypt a limit for storage on-chain.
 *
 * Fresh randomness per call is what makes this hiding at all — encrypting with
 * a fixed opening would let an observer confirm a guessed limit by re-encrypting
 * it and comparing bytes.
 */
export function encryptLimit(keypair: ElGamalKeypair, value: bigint): Uint8Array {
  return keypair.pubkey().encryptU64(value).toBytes();
}

/** The canonical encryption of zero: the Ristretto identity twice over. */
export function encryptedZero(): Uint8Array {
  return new Uint8Array(64);
}

/**
 * Build everything needed for one confidential authorization.
 *
 * Throws rather than producing an unprovable statement when the spend is out of
 * policy. That is not the enforcement — the program's check is — but failing
 * here gives a caller a readable reason instead of an opaque proof-generation
 * error from inside wasm.
 */
export function buildConfidentialAuthorization(
  keypair: ElGamalKeypair,
  state: ConfidentialLimitState,
  values: ConfidentialLimitValues,
  amount: bigint,
): ConfidentialAuthorization {
  const transferDifference = values.maxPerTransfer - amount;
  const periodDifference = values.maxPerPeriod - (values.spentInPeriod + amount);

  if (transferDifference < 0n) {
    throw new Error(
      `Transfer of ${amount} exceeds the per-transfer limit — no proof of compliance exists.`,
    );
  }
  if (periodDifference < 0n) {
    throw new Error(
      `Transfer of ${amount} would exceed the period limit — no proof of compliance exists.`,
    );
  }
  for (const difference of [transferDifference, periodDifference]) {
    if (difference > MAX_PROVABLE_DIFFERENCE) {
      throw new Error(
        `Difference ${difference} exceeds what a ${RANGE_BIT_LENGTH}-bit range proof can cover ` +
          `(max ${MAX_PROVABLE_DIFFERENCE}). Lower the limits or raise the bit length on both sides.`,
      );
    }
  }

  const amountCiphertextObject = keypair.pubkey().encryptU64(amount);
  const amountCiphertext = amountCiphertextObject.toBytes();

  // Recomputed here exactly as the program recomputes it on-chain. If these two
  // ever disagree by a single byte the equality proof will not match and the
  // authorization is refused — which is the intended failure, not a bug.
  const transferDifferenceCt = subtractCiphertexts(
    ciphertextFrom(state.maxPerTransferCt),
    amountCiphertextObject,
  );
  const newSpentCt = addCiphertexts(ciphertextFrom(state.spentInPeriodCt), amountCiphertextObject);
  const periodDifferenceCt = subtractCiphertexts(ciphertextFrom(state.maxPerPeriodCt), newSpentCt);

  const transferOpening = new PedersenOpening();
  const periodOpening = new PedersenOpening();
  const transferCommitment = PedersenCommitment.from(transferDifference, transferOpening);
  const periodCommitment = PedersenCommitment.from(periodDifference, periodOpening);

  // Equality proofs before the range proof: the range proof consumes both
  // commitments and openings (see the module docs).
  const transferEqualityProof = new CiphertextCommitmentEqualityProofData(
    keypair,
    transferDifferenceCt,
    transferCommitment,
    transferOpening,
    transferDifference,
  ).toBytes();

  const periodEqualityProof = new CiphertextCommitmentEqualityProofData(
    keypair,
    periodDifferenceCt,
    periodCommitment,
    periodOpening,
    periodDifference,
  ).toBytes();

  const rangeProof = new BatchedRangeProofU64Data(
    [transferCommitment, periodCommitment],
    // The binding wants a BigUint64Array here specifically, not a bigint[].
    BigUint64Array.from([transferDifference, periodDifference]),
    new Uint8Array([RANGE_BIT_LENGTH, RANGE_BIT_LENGTH]),
    [transferOpening, periodOpening],
  ).toBytes();

  return { amountCiphertext, transferEqualityProof, periodEqualityProof, rangeProof };
}

function ciphertextFrom(bytes: Uint8Array): ElGamalCiphertext {
  const ciphertext = ElGamalCiphertext.fromBytes(bytes);
  if (!ciphertext) {
    throw new Error("Stored limit is not a valid ElGamal ciphertext");
  }
  return ciphertext;
}
