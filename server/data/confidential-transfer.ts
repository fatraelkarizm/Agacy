import type { Address, KeyPairSigner } from "@solana/kit";
import {
  getApplyConfidentialPendingBalanceInstruction,
  getConfidentialDepositInstruction,
  getConfidentialTransferInstruction,
  getMintToInstruction,
} from "@solana-program/token-2022";
import { ElGamalPubkey, type ElGamalCiphertext } from "@solana/zk-sdk/node";
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
} from "@solana-program/zk-elgamal-proof";
import type { SolanaClient } from "./solana-client.js";
import { sendInstructions } from "./confidential-mint.js";
import type { ConfidentialKeys } from "./confidential-keys.js";
import { generateTransferProofs } from "./confidential-proofs.js";
import { extractHandleCiphertext } from "./elgamal-arithmetic.js";

/**
 * The confidential transfer lifecycle.
 *
 * Value does not go straight into a confidential balance. It moves through
 * three stages, and skipping one is the most common source of "why is my
 * balance zero" confusion:
 *
 *   public balance --deposit--> pending confidential --apply--> available confidential
 *
 * The pending stage exists so an attacker cannot grief an account by flooding it
 * with tiny incoming transfers: incoming amounts land in `pending`, and the owner
 * decides when to fold them into the spendable `available` balance. Only
 * `available` can be transferred out.
 */

/** Handle order inside a 3-handle grouped ciphertext. */
const AUDITOR_HANDLE_INDEX = 2;

export interface DepositParams {
  readonly tokenAccount: Address;
  readonly mint: Address;
  readonly owner: KeyPairSigner;
  readonly amount: bigint;
  readonly decimals: number;
}

/** Mint public tokens, then move them into the account's pending confidential balance. */
export async function depositToConfidentialBalance(
  client: SolanaClient,
  payer: KeyPairSigner,
  mintAuthority: KeyPairSigner,
  params: DepositParams,
): Promise<string> {
  return sendInstructions(client, payer, [
    getMintToInstruction({
      mint: params.mint,
      token: params.tokenAccount,
      mintAuthority,
      amount: params.amount,
    }),
    getConfidentialDepositInstruction({
      token: params.tokenAccount,
      mint: params.mint,
      authority: params.owner,
      amount: params.amount,
      decimals: params.decimals,
    }),
  ]);
}

export interface ApplyPendingParams {
  readonly tokenAccount: Address;
  readonly owner: KeyPairSigner;
  readonly keys: ConfidentialKeys;
  /** Balance the account will hold once pending credits are folded in. */
  readonly newAvailableBalance: bigint;
  /**
   * The account's pending credit counter as last observed. The program rejects
   * a stale value, which prevents applying against a balance that changed
   * underneath you between reading and signing.
   */
  readonly expectedPendingCreditCounter: bigint;
}

/** Fold pending credits into the spendable available balance. */
export async function applyPendingBalance(
  client: SolanaClient,
  payer: KeyPairSigner,
  params: ApplyPendingParams,
): Promise<string> {
  return sendInstructions(client, payer, [
    getApplyConfidentialPendingBalanceInstruction({
      token: params.tokenAccount,
      authority: params.owner,
      expectedPendingBalanceCreditCounter: params.expectedPendingCreditCounter,
      newDecryptableAvailableBalance: params.keys.ae
        .encrypt(params.newAvailableBalance)
        .toBytes() as never,
    }),
  ]);
}

export interface ConfidentialTransferParams {
  readonly sourceToken: Address;
  readonly destinationToken: Address;
  readonly mint: Address;
  readonly owner: KeyPairSigner;
  readonly senderKeys: ConfidentialKeys;
  readonly recipientElGamalPubkey: ElGamalPubkey;
  /** Sender's current decrypted available balance. */
  readonly availableBalance: bigint;
  /** Sender's on-chain encrypted available balance. */
  readonly availableBalanceCiphertext: ElGamalCiphertext;
  readonly amount: bigint;
}

/**
 * Execute a confidential transfer.
 *
 * All three proofs are verified by the ZK ElGamal Proof program in the same
 * transaction, and the transfer instruction points at them by relative offset.
 * The offsets are negative because the proof instructions are appended *after*
 * the transfer instruction in the message — the transfer looks forward to them.
 */
export async function executeConfidentialTransfer(
  client: SolanaClient,
  payer: KeyPairSigner,
  params: ConfidentialTransferParams,
): Promise<{ signature: string; remainingBalance: bigint }> {
  // No auditor is configured for Agacy's mint, so the protocol's required third
  // key is the sender's own — it satisfies the 3-handle format without handing
  // any outside party the ability to decrypt amounts.
  const auditorPubkey = params.senderKeys.elGamal.pubkey();

  const proofs = generateTransferProofs({
    senderKeypair: params.senderKeys.elGamal,
    recipientPubkey: params.recipientElGamalPubkey,
    auditorPubkey,
    availableBalance: params.availableBalance,
    amount: params.amount,
    availableBalanceCiphertext: params.availableBalanceCiphertext,
  });

  const [equalityIxs, validityIxs, rangeIxs] = await Promise.all([
    verifyCiphertextCommitmentEquality({
      rpc: client.rpc,
      payer,
      proofData: proofs.equality.toBytes(),
    }),
    verifyBatchedGroupedCiphertext3HandlesValidity({
      rpc: client.rpc,
      payer,
      proofData: proofs.ciphertextValidity.toBytes(),
    }),
    verifyBatchedRangeProofU128({
      rpc: client.rpc,
      payer,
      proofData: proofs.range.toBytes(),
    }),
  ]);

  const transferIx = getConfidentialTransferInstruction({
    sourceToken: params.sourceToken,
    mint: params.mint,
    destinationToken: params.destinationToken,
    authority: params.owner,
    newSourceDecryptableAvailableBalance: params.senderKeys.ae
      .encrypt(proofs.remainingBalance)
      .toBytes() as never,
    transferAmountAuditorCiphertextLo: extractHandleCiphertext(
      proofs.groupedLo.toBytes(),
      AUDITOR_HANDLE_INDEX,
    ).toBytes() as never,
    transferAmountAuditorCiphertextHi: extractHandleCiphertext(
      proofs.groupedHi.toBytes(),
      AUDITOR_HANDLE_INDEX,
    ).toBytes() as never,
    equalityProofInstructionOffset: 1,
    ciphertextValidityProofInstructionOffset: 2,
    rangeProofInstructionOffset: 3,
  });

  const signature = await sendInstructions(client, payer, [
    transferIx,
    ...equalityIxs,
    ...validityIxs,
    ...rangeIxs,
  ]);

  return { signature, remainingBalance: proofs.remainingBalance };
}
