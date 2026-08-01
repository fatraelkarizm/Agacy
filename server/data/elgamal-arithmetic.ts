import { RistrettoPoint } from "@noble/curves/ed25519";
import { ElGamalCiphertext } from "@solana/zk-sdk/node";

/**
 * Homomorphic ciphertext arithmetic.
 *
 * Solana's confidential transfer requires the sender to prove things about their
 * *post-transfer* balance ciphertext — the value the Token-2022 program will
 * compute on-chain as `old_balance_ciphertext - transfer_amount_ciphertext`.
 * The client has to derive the identical ciphertext locally to build the
 * equality proof over it.
 *
 * `@solana/zk-sdk` exposes ciphertexts only as opaque byte blobs, with no
 * add/subtract, so we do the group arithmetic directly. An ElGamal ciphertext
 * here is two compressed Ristretto255 points laid out back to back:
 *   bytes[0..32]  = Pedersen commitment  C = amount·G + opening·H
 *   bytes[32..64] = decrypt handle       D = opening·P   (P = recipient pubkey)
 *
 * Both components are additively homomorphic, so subtracting two ciphertexts is
 * just subtracting each component pointwise.
 */

const CIPHERTEXT_BYTES = 64;
const POINT_BYTES = 32;

function splitCiphertext(bytes: Uint8Array): { commitment: Uint8Array; handle: Uint8Array } {
  if (bytes.length !== CIPHERTEXT_BYTES) {
    throw new Error(`Expected a ${CIPHERTEXT_BYTES}-byte ElGamal ciphertext, got ${bytes.length}`);
  }
  return {
    commitment: bytes.subarray(0, POINT_BYTES),
    handle: bytes.subarray(POINT_BYTES, CIPHERTEXT_BYTES),
  };
}

function subtractPoints(a: Uint8Array, b: Uint8Array): Uint8Array {
  return RistrettoPoint.fromBytes(a).subtract(RistrettoPoint.fromBytes(b)).toBytes();
}

/**
 * Compute `left - right` as ElGamal ciphertexts.
 *
 * The result decrypts to the difference of the two plaintexts under the same
 * key, which is exactly how the Token-2022 program derives a sender's new
 * available balance after a confidential transfer.
 */
export function subtractCiphertexts(
  left: ElGamalCiphertext,
  right: ElGamalCiphertext,
): ElGamalCiphertext {
  const l = splitCiphertext(left.toBytes());
  const r = splitCiphertext(right.toBytes());

  const result = new Uint8Array(CIPHERTEXT_BYTES);
  result.set(subtractPoints(l.commitment, r.commitment), 0);
  result.set(subtractPoints(l.handle, r.handle), POINT_BYTES);

  const ciphertext = ElGamalCiphertext.fromBytes(result);
  if (!ciphertext) {
    throw new Error("Ciphertext subtraction produced invalid bytes");
  }
  return ciphertext;
}

function addPoints(a: Uint8Array, b: Uint8Array): Uint8Array {
  return RistrettoPoint.fromBytes(a).add(RistrettoPoint.fromBytes(b)).toBytes();
}

function scalePoint(point: Uint8Array, scalar: bigint): Uint8Array {
  return RistrettoPoint.fromBytes(point).multiply(scalar).toBytes();
}

/**
 * Recombine the split transfer amount into a single ciphertext.
 *
 * The protocol encrypts the amount as two parts (low 16 bits, high 32 bits),
 * so the full amount's ciphertext is `lo + 2^16 · hi`. Scalar multiplication
 * of a ciphertext scales the underlying plaintext, which is what lets the
 * high part carry its positional weight.
 */
export function combineTransferAmountCiphertexts(
  lo: ElGamalCiphertext,
  hi: ElGamalCiphertext,
  loBits: number,
): ElGamalCiphertext {
  const weight = 1n << BigInt(loBits);
  const l = splitCiphertext(lo.toBytes());
  const h = splitCiphertext(hi.toBytes());

  const result = new Uint8Array(CIPHERTEXT_BYTES);
  result.set(addPoints(l.commitment, scalePoint(h.commitment, weight)), 0);
  result.set(addPoints(l.handle, scalePoint(h.handle, weight)), POINT_BYTES);

  const ciphertext = ElGamalCiphertext.fromBytes(result);
  if (!ciphertext) {
    throw new Error("Combining transfer amount ciphertexts produced invalid bytes");
  }
  return ciphertext;
}

/**
 * Extract one party's ElGamal ciphertext from a 3-handle grouped ciphertext.
 *
 * A grouped ciphertext shares one commitment across three decrypt handles
 * (sender, recipient, auditor) so all three can decrypt the same amount. Layout:
 *   bytes[0..32]   = shared commitment
 *   bytes[32..64]  = handle 0 (sender)
 *   bytes[64..96]  = handle 1 (recipient)
 *   bytes[96..128] = handle 2 (auditor)
 */
export function extractHandleCiphertext(
  groupedBytes: Uint8Array,
  handleIndex: 0 | 1 | 2,
): ElGamalCiphertext {
  const expectedLength = POINT_BYTES * 4;
  if (groupedBytes.length !== expectedLength) {
    throw new Error(
      `Expected a ${expectedLength}-byte 3-handle grouped ciphertext, got ${groupedBytes.length}`,
    );
  }

  const result = new Uint8Array(CIPHERTEXT_BYTES);
  result.set(groupedBytes.subarray(0, POINT_BYTES), 0);
  const handleStart = POINT_BYTES * (handleIndex + 1);
  result.set(groupedBytes.subarray(handleStart, handleStart + POINT_BYTES), POINT_BYTES);

  const ciphertext = ElGamalCiphertext.fromBytes(result);
  if (!ciphertext) {
    throw new Error(`Could not extract handle ${handleIndex} from grouped ciphertext`);
  }
  return ciphertext;
}
