import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { getConfidentialTransferInstruction, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  closeContextStateProof,
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
} from "@solana-program/zk-elgamal-proof";
import { ElGamalPubkey, type ElGamalCiphertext } from "@solana/zk-sdk/node";
import { buildAuthorizeAndInvokeInstruction } from "./policy-program-v2";
import { sendInstructions } from "./confidential-mint";
import { generateTransferProofs } from "./confidential-proofs";
import { extractHandleCiphertext } from "./elgamal-arithmetic";
import type { ConfidentialKeys } from "./confidential-keys";
import type { SolanaClient } from "./solana-client";

const AUDITOR_HANDLE_INDEX = 2;
const pause = () => new Promise((resolve) => setTimeout(resolve, 3_000));

export interface PolicyConfidentialTransferParams {
  readonly policyAccount: Address;
  readonly sourceToken: Address;
  readonly destinationToken: Address;
  readonly mint: Address;
  readonly agent: KeyPairSigner;
  readonly senderKeys: ConfidentialKeys;
  readonly recipientElGamalPubkey: ElGamalPubkey;
  readonly availableBalance: bigint;
  readonly availableBalanceCiphertext: ElGamalCiphertext;
  readonly amount: bigint;
}

/** Real Token-2022 transfer whose authority and amount limit are enforced by the policy PDA. */
export async function executePolicyConfidentialTransfer(
  client: SolanaClient,
  params: PolicyConfidentialTransferParams,
): Promise<{ readonly signature: string; readonly remainingBalance: bigint }> {
  const proofs = generateTransferProofs({
    senderKeypair: params.senderKeys.elGamal,
    recipientPubkey: params.recipientElGamalPubkey,
    auditorPubkey: ElGamalPubkey.fromBytes(new Uint8Array(32)),
    availableBalance: params.availableBalance,
    amount: params.amount,
    availableBalanceCiphertext: params.availableBalanceCiphertext,
  });
  const equalityContext = await generateKeyPairSigner();
  const validityContext = await generateKeyPairSigner();
  const rangeContext = await generateKeyPairSigner();
  const payer = params.agent;

  const equality = await verifyCiphertextCommitmentEquality({
    rpc: client.rpc,
    payer,
    proofData: proofs.equality.toBytes(),
    contextState: { contextAccount: equalityContext, authority: payer.address },
  });
  const validity = await verifyBatchedGroupedCiphertext3HandlesValidity({
    rpc: client.rpc,
    payer,
    proofData: proofs.ciphertextValidity.toBytes(),
    contextState: { contextAccount: validityContext, authority: payer.address },
  });
  const range = await verifyBatchedRangeProofU128({
    rpc: client.rpc,
    payer,
    proofData: proofs.range.toBytes(),
    contextState: { contextAccount: rangeContext, authority: payer.address },
  });

  await sendInstructions(client, payer, equality);
  await pause();
  await sendInstructions(client, payer, validity);
  await pause();
  await sendInstructions(client, payer, range.slice(0, -1));
  await pause();
  await sendInstructions(client, payer, range.slice(-1));
  await pause();

  const transfer = getConfidentialTransferInstruction({
    sourceToken: params.sourceToken,
    mint: params.mint,
    destinationToken: params.destinationToken,
    authority: params.policyAccount,
    equalityRecord: equalityContext.address,
    ciphertextValidityRecord: validityContext.address,
    rangeRecord: rangeContext.address,
    newSourceDecryptableAvailableBalance: params.senderKeys.ae
      .encrypt(proofs.remainingBalance).toBytes() as never,
    transferAmountAuditorCiphertextLo: extractHandleCiphertext(
      proofs.groupedLo.toBytes(), AUDITOR_HANDLE_INDEX,
    ).toBytes() as never,
    transferAmountAuditorCiphertextHi: extractHandleCiphertext(
      proofs.groupedHi.toBytes(), AUDITOR_HANDLE_INDEX,
    ).toBytes() as never,
    equalityProofInstructionOffset: 0,
    ciphertextValidityProofInstructionOffset: 0,
    rangeProofInstructionOffset: 0,
  });

  try {
    const signature = await sendInstructions(client, payer, [
      buildAuthorizeAndInvokeInstruction({
        policyAccount: params.policyAccount,
        agent: payer,
        targetProgram: TOKEN_2022_PROGRAM_ADDRESS,
        amount: params.amount,
        instructionData: new Uint8Array(transfer.data),
        forwardedAccounts: transfer.accounts.map((account) => ({
          address: account.address,
          role: account.role as 0 | 1 | 2 | 3,
        })),
      }),
    ]);
    return { signature, remainingBalance: proofs.remainingBalance };
  } finally {
    await pause();
    try {
      await sendInstructions(client, payer, [
        closeContextStateProof({ contextState: equalityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: validityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: rangeContext.address, authority: payer, destination: payer.address }),
      ]);
    } catch (error) {
      console.warn("Proof-account cleanup failed after payment:", (error as Error).message);
    }
  }
}
