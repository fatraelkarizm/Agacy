import {
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalKeypair,
  ElGamalPubkey,
  GroupedElGamalCiphertext3Handles,
  PedersenCommitment,
  PedersenOpening,
} from "@solana/zk-sdk/node";
import {
  combineTransferAmountCiphertexts,
  extractHandleCiphertext,
  subtractCiphertexts,
} from "./elgamal-arithmetic.js";

/** In a 3-handle grouped ciphertext the handles are ordered sender, recipient, auditor. */
const SENDER_HANDLE_INDEX = 0;
export const RECIPIENT_HANDLE_INDEX = 1;

/**
 * Proof generation for a confidential transfer.
 *
 * This runs client-side by necessity, not by preference: the proofs are what
 * convince the chain that a transfer is valid *without* revealing the amount,
 * and generating them requires the plaintext amount and the sender's secret key.
 * Sending those to a server or a program to "do the heavy work" would defeat
 * the entire point — the secret would be exposed in the very place we're
 * trying to hide it from.
 *
 * The chain's side of this is verification, which the ZK ElGamal Proof program
 * (deployed by Solana) already handles.
 */

/**
 * Confidential transfer splits the amount into a 16-bit low part and a 32-bit
 * high part, so the largest transferable amount is 2^48 - 1 base units.
 * The split exists because the range proof batches differently-sized values,
 * and it keeps the ciphertext-validity proof cheap for the low bits.
 */
export const TRANSFER_AMOUNT_LO_BITS = 16;
export const TRANSFER_AMOUNT_HI_BITS = 32;
export const MAX_TRANSFER_AMOUNT = (1n << 48n) - 1n;

/** Remaining-balance commitment is proven over the full 64-bit range. */
const REMAINING_BALANCE_BITS = 64;
/** Padding so the batched range proof's bit lengths sum to exactly 128. */
const PADDING_BITS = 16;

export interface TransferAmountParts {
  readonly lo: bigint;
  readonly hi: bigint;
}

export function splitTransferAmount(amount: bigint): TransferAmountParts {
  if (amount < 0n) throw new Error("Transfer amount cannot be negative");
  if (amount > MAX_TRANSFER_AMOUNT) {
    throw new Error(
      `Transfer amount ${amount} exceeds the confidential transfer maximum of ${MAX_TRANSFER_AMOUNT}`,
    );
  }
  return {
    lo: amount & ((1n << BigInt(TRANSFER_AMOUNT_LO_BITS)) - 1n),
    hi: (amount >> BigInt(TRANSFER_AMOUNT_LO_BITS)) & ((1n << BigInt(TRANSFER_AMOUNT_HI_BITS)) - 1n),
  };
}

/** Inverse of splitTransferAmount — useful for verifying a round trip. */
export function joinTransferAmount(parts: TransferAmountParts): bigint {
  return parts.lo + (parts.hi << BigInt(TRANSFER_AMOUNT_LO_BITS));
}

export interface TransferProofInput {
  /** Sender's confidential keypair — never leaves this process. */
  readonly senderKeypair: ElGamalKeypair;
  readonly recipientPubkey: ElGamalPubkey;
  /** Mint auditor's key. Required by the protocol; use the sender's own key when no auditor is configured. */
  readonly auditorPubkey: ElGamalPubkey;
  /** Sender's currently available (decrypted) balance, in base units. */
  readonly availableBalance: bigint;
  /** Amount to transfer, in base units. */
  readonly amount: bigint;
  /** The sender's on-chain encrypted available balance. */
  readonly availableBalanceCiphertext: ElGamalCiphertext;
}

export interface TransferProofs {
  readonly equality: CiphertextCommitmentEqualityProofData;
  readonly ciphertextValidity: BatchedGroupedCiphertext3HandlesValidityProofData;
  readonly range: BatchedRangeProofU128Data;
  /** Grouped ciphertexts of the transfer amount, needed by the transfer instruction. */
  readonly groupedLo: GroupedElGamalCiphertext3Handles;
  readonly groupedHi: GroupedElGamalCiphertext3Handles;
  readonly remainingBalance: bigint;
}

/**
 * Generate the three proofs a confidential transfer requires:
 *
 *  1. Equality — the sender's new (post-transfer) balance commitment really
 *     corresponds to their encrypted balance. Stops a sender from claiming an
 *     arbitrary remaining balance.
 *  2. Ciphertext validity — the transfer-amount ciphertexts are well-formed
 *     under all three keys (sender, recipient, auditor) and encrypt the same
 *     value. Stops a sender from encrypting different amounts to each party.
 *  3. Range — the remaining balance and the transfer amount are all
 *     non-negative and within their bit bounds. Stops the wraparound trick of
 *     "transferring" a negative amount to mint value out of nothing.
 */
export function generateTransferProofs(input: TransferProofInput): TransferProofs {
  const { senderKeypair, recipientPubkey, auditorPubkey, availableBalance, amount } = input;

  if (amount > availableBalance) {
    throw new Error(`Insufficient confidential balance: have ${availableBalance}, need ${amount}`);
  }

  const parts = splitTransferAmount(amount);
  const remainingBalance = availableBalance - amount;

  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const openingRemaining = new PedersenOpening();

  const senderPubkey = senderKeypair.pubkey();

  const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(
    senderPubkey,
    recipientPubkey,
    auditorPubkey,
    parts.lo,
    openingLo,
  );
  const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(
    senderPubkey,
    recipientPubkey,
    auditorPubkey,
    parts.hi,
    openingHi,
  );

  const ciphertextValidity = new BatchedGroupedCiphertext3HandlesValidityProofData(
    senderPubkey,
    recipientPubkey,
    auditorPubkey,
    groupedLo,
    groupedHi,
    parts.lo,
    parts.hi,
    openingLo,
    openingHi,
  );

  // The equality proof must be over the sender's *post-transfer* ciphertext —
  // the exact value Token-2022 will derive on-chain by homomorphically
  // subtracting the transfer amount from the stored balance. We reproduce that
  // subtraction locally so the proof matches what the program will check.
  const transferCiphertextForSender = combineTransferAmountCiphertexts(
    extractHandleCiphertext(groupedLo.toBytes(), SENDER_HANDLE_INDEX),
    extractHandleCiphertext(groupedHi.toBytes(), SENDER_HANDLE_INDEX),
    TRANSFER_AMOUNT_LO_BITS,
  );
  const newSourceCiphertext = subtractCiphertexts(
    input.availableBalanceCiphertext,
    transferCiphertextForSender,
  );

  const remainingCommitment = PedersenCommitment.from(remainingBalance, openingRemaining);

  const equality = new CiphertextCommitmentEqualityProofData(
    senderKeypair,
    newSourceCiphertext,
    remainingCommitment,
    openingRemaining,
    remainingBalance,
  );

  // Bit lengths must sum to 128 and each be a power of two; the trailing
  // padding entry exists purely to reach 128.
  const paddingOpening = new PedersenOpening();

  const range = new BatchedRangeProofU128Data(
    [
      remainingCommitment,
      PedersenCommitment.from(parts.lo, openingLo),
      PedersenCommitment.from(parts.hi, openingHi),
      PedersenCommitment.from(0n, paddingOpening),
    ],
    new BigUint64Array([remainingBalance, parts.lo, parts.hi, 0n]),
    new Uint8Array([
      REMAINING_BALANCE_BITS,
      TRANSFER_AMOUNT_LO_BITS,
      TRANSFER_AMOUNT_HI_BITS,
      PADDING_BITS,
    ]),
    [openingRemaining, openingLo, openingHi, paddingOpening],
  );

  return { equality, ciphertextValidity, range, groupedLo, groupedHi, remainingBalance };
}
