import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
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
  closeContextStateProof,
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

/** Spacing between sequential transactions, to stay under the public RPC rate limit. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 3_000));

/**
 * Send a proof's setup instructions and its verification in separate
 * transactions. The verify instruction carries the full proof bytes, so it has
 * to travel alone to stay under the transaction size limit.
 */
async function sendProofInstructionsSeparately(
  client: SolanaClient,
  payer: KeyPairSigner,
  instructions: readonly unknown[],
): Promise<void> {
  const setup = instructions.slice(0, -1);
  const verify = instructions.slice(-1);

  if (setup.length > 0) {
    await sendInstructions(client, payer, setup);
    await pause();
  }
  await sendInstructions(client, payer, verify);
}

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
  // Agacy's mint configures no auditor. The transfer format still carries a
  // third handle, and the program checks it against the mint's auditor key —
  // so it must be the all-zero default, not a stand-in like the sender's own
  // key, which fails on-chain with "ElGamal public key mismatch".
  const auditorPubkey = ElGamalPubkey.fromBytes(new Uint8Array(32));

  const proofs = generateTransferProofs({
    senderKeypair: params.senderKeys.elGamal,
    recipientPubkey: params.recipientElGamalPubkey,
    auditorPubkey,
    availableBalance: params.availableBalance,
    amount: params.amount,
    availableBalanceCiphertext: params.availableBalanceCiphertext,
  });

  // The three proofs together are ~3KB, well past Solana's 1232-byte
  // transaction limit, so they cannot be inlined alongside the transfer.
  // Instead each proof is verified into its own context state account first;
  // the transfer then references those accounts and stays small. The rent is
  // reclaimed by closing the context accounts once the transfer lands.
  const equalityContext = await generateKeyPairSigner();
  const validityContext = await generateKeyPairSigner();
  const rangeContext = await generateKeyPairSigner();

  const contextAuthority = payer.address;

  const equalityIxs = await verifyCiphertextCommitmentEquality({
    rpc: client.rpc,
    payer,
    proofData: proofs.equality.toBytes(),
    contextState: { contextAccount: equalityContext, authority: contextAuthority },
  });
  const validityIxs = await verifyBatchedGroupedCiphertext3HandlesValidity({
    rpc: client.rpc,
    payer,
    proofData: proofs.ciphertextValidity.toBytes(),
    contextState: { contextAccount: validityContext, authority: contextAuthority },
  });
  const rangeIxs = await verifyBatchedRangeProofU128({
    rpc: client.rpc,
    payer,
    proofData: proofs.range.toBytes(),
    contextState: { contextAccount: rangeContext, authority: contextAuthority },
  });

  // Each proof gets its own transaction. Equality (~321 bytes) and validity fit
  // alongside their context-account creation; the U128 range proof does not, so
  // its creation and verification are split across two transactions.
  //
  // These are paced deliberately: the public devnet RPC rate-limits a burst of
  // transactions, and a 429 mid-flow is genuinely ambiguous — the transaction
  // may or may not have landed — so it is better to avoid tripping it than to
  // retry into an "already initialized" error.
  await sendInstructions(client, payer, equalityIxs);
  await pause();
  await sendInstructions(client, payer, validityIxs);
  await pause();
  await sendProofInstructionsSeparately(client, payer, rangeIxs);
  await pause();

  // Offset 0 tells the program to read the proof from the context state
  // account passed in the corresponding slot, rather than from an instruction.
  const transferIx = getConfidentialTransferInstruction({
    sourceToken: params.sourceToken,
    mint: params.mint,
    destinationToken: params.destinationToken,
    authority: params.owner,
    equalityRecord: equalityContext.address,
    ciphertextValidityRecord: validityContext.address,
    rangeRecord: rangeContext.address,
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
    equalityProofInstructionOffset: 0,
    ciphertextValidityProofInstructionOffset: 0,
    rangeProofInstructionOffset: 0,
  });

  let signature: string;
  try {
    signature = await sendInstructions(client, payer, [transferIx]);
  } catch (cause) {
    throw new Error("Confidential transfer instruction failed", { cause });
  }
  await pause();

  // Reclaim the rent now that the proofs have served their purpose.
  try {
    await sendInstructions(client, payer, [
    closeContextStateProof({
      contextState: equalityContext.address,
      authority: payer,
      destination: payer.address,
    }),
    closeContextStateProof({
      contextState: validityContext.address,
      authority: payer,
      destination: payer.address,
    }),
    closeContextStateProof({
      contextState: rangeContext.address,
      authority: payer,
      destination: payer.address,
    }),
    ]);
  } catch (cause) {
    // Cleanup only reclaims rent; the transfer already landed, so a failure
    // here must not be reported as a failed payment.
    console.warn('Context state cleanup failed (rent not reclaimed):', (cause as Error).message);
  }

  return { signature, remainingBalance: proofs.remainingBalance };
}
