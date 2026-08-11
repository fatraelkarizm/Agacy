import { generateKeyPairSigner, type Address, type TransactionSigner } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, getConfidentialTransferInstruction } from "@solana-program/token-2022";
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU64,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
  closeContextStateProof,
} from "@solana-program/zk-elgamal-proof";
import { ElGamalCiphertext, ElGamalPubkey } from "@solana/zk-sdk/node";
import type { SolanaClient } from "./solana-client.js";
import type { loadOrCreatePayer } from "./solana-payer.js";
import { sendInstructions } from "./confidential-mint.js";
import { generateTransferProofs } from "./confidential-proofs.js";
import {
  combineTransferAmountCiphertexts,
  extractHandleCiphertext,
} from "./elgamal-arithmetic.js";
import type { fetchConfidentialBalance } from "./confidential-balance.js";
import type { deriveConfidentialKeys } from "./confidential-keys.js";
import {
  buildAuthorizeConfidentialAndInvokeInstruction,
  fetchPolicyV2Account,
} from "./policy-program-v2.js";
import { buildConfidentialAuthorization, encryptedZero } from "./confidential-limits.js";

/**
 * A confidential transfer that has to get past the on-chain spend policy first.
 *
 * The difference from `confidential-transfer.ts` is who signs. There, the
 * account owner authorizes their own transfer. Here the policy PDA is the
 * account's owner, and the transfer is forwarded through
 * `authorize_and_invoke` — so the program checks the limit and *then* produces
 * the signature, and there is no path to the funds that skips it.
 *
 * This exists because the autonomous agent's limit was previously enforced by
 * a TypeScript wrapper (`agent/policy-guard.ts`) rather than by the deployed
 * program. That wrapper is good hygiene and stays, but it is exactly the kind
 * of "the code politely asks itself" guarantee this project argues against
 * everywhere else. Anything holding the token account's authority could have
 * ignored it.
 *
 * Requires the policy PDA to already hold custody of `sourceToken`; Token-2022
 * refuses delegate authority for confidential transfers outright, so custody is
 * not an optimisation here but the only arrangement that works.
 */

const AUDITOR_HANDLE_INDEX = 2;
const SOURCE_HANDLE_INDEX = 0;
const TRANSFER_AMOUNT_LO_BITS = 16;
const pause = () => new Promise((resolve) => setTimeout(resolve, 3_000));

export interface PolicyGatedTransferParams {
  readonly policyAccount: Address;
  readonly agent: TransactionSigner;
  readonly sourceToken: Address;
  readonly destinationToken: Address;
  readonly mint: Address;
  readonly senderKeys: ReturnType<typeof deriveConfidentialKeys>;
  readonly recipientElGamalPubkey: ElGamalPubkey;
  readonly availableBalance: bigint;
  readonly availableBalanceCiphertext: Awaited<
    ReturnType<typeof fetchConfidentialBalance>
  >["availableBalanceCiphertext"];
  readonly amount: bigint;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  /** Included in the same transaction so a payment and its audit record cannot diverge. */
  readonly additionalInstructions?: readonly unknown[];
  /** Test-only attack input: a different claimed amount must be rejected on-chain. */
  readonly policyProofAmount?: bigint;
}

export async function policyGatedConfidentialTransfer(
  client: SolanaClient,
  payer: Awaited<ReturnType<typeof loadOrCreatePayer>>,
  params: PolicyGatedTransferParams,
): Promise<{ signature: string; remainingBalance: bigint }> {
  const auditorPubkey = ElGamalPubkey.fromBytes(new Uint8Array(32));

  const proofs = generateTransferProofs({
    senderKeypair: params.senderKeys.elGamal,
    recipientPubkey: params.recipientElGamalPubkey,
    auditorPubkey,
    availableBalance: params.availableBalance,
    amount: params.amount,
    availableBalanceCiphertext: params.availableBalanceCiphertext,
  });

  const policy = await fetchPolicyV2Account(client, params.policyAccount);
  if (!policy?.confidentialLimits) {
    throw new Error("Policy account has no confidential limits configured");
  }
  if (policy.custodiedTokenAccount !== params.sourceToken) {
    throw new Error("Policy does not custody the confidential source account");
  }
  const senderPubkey = params.senderKeys.elGamal.pubkey().toBytes();
  if (!Buffer.from(policy.confidentialLimits.limitPubkey).equals(Buffer.from(senderPubkey))) {
    throw new Error("Policy limit key must match the source account ElGamal key");
  }

  const amountCiphertext = combineTransferAmountCiphertexts(
    extractHandleCiphertext(proofs.groupedLo.toBytes(), SOURCE_HANDLE_INDEX),
    extractHandleCiphertext(proofs.groupedHi.toBytes(), SOURCE_HANDLE_INDEX),
    TRANSFER_AMOUNT_LO_BITS,
  ).toBytes();
  const periodElapsed =
    BigInt(Math.floor(Date.now() / 1_000)) - policy.periodStart >= policy.periodSeconds;
  const spentInPeriodCt = periodElapsed
    ? encryptedZero()
    : policy.confidentialLimits.spentInPeriodCt;
  const spentCiphertext = ElGamalCiphertext.fromBytes(spentInPeriodCt);
  if (!spentCiphertext) throw new Error("Stored policy spend is not a valid ciphertext");
  const spentInPeriod = periodElapsed
    ? 0n
    : params.senderKeys.elGamal.secret().decrypt(spentCiphertext);
  const policyProofAmount = params.policyProofAmount ?? params.amount;
  const authorization = buildConfidentialAuthorization(
    params.senderKeys.elGamal,
    { ...policy.confidentialLimits, spentInPeriodCt },
    {
      maxPerTransfer: params.maxPerTransfer,
      maxPerPeriod: params.maxPerPeriod,
      spentInPeriod,
    },
    policyProofAmount,
    policyProofAmount === params.amount ? amountCiphertext : undefined,
  );

  const equalityContext = await generateKeyPairSigner();
  const validityContext = await generateKeyPairSigner();
  const rangeContext = await generateKeyPairSigner();
  const transferLimitEqualityContext = await generateKeyPairSigner();
  const periodLimitEqualityContext = await generateKeyPairSigner();
  const limitRangeContext = await generateKeyPairSigner();

  const equalityIxs = await verifyCiphertextCommitmentEquality({
    rpc: client.rpc, payer, proofData: proofs.equality.toBytes(),
    contextState: { contextAccount: equalityContext, authority: payer.address },
  });
  const validityIxs = await verifyBatchedGroupedCiphertext3HandlesValidity({
    rpc: client.rpc, payer, proofData: proofs.ciphertextValidity.toBytes(),
    contextState: { contextAccount: validityContext, authority: payer.address },
  });
  const rangeIxs = await verifyBatchedRangeProofU128({
    rpc: client.rpc, payer, proofData: proofs.range.toBytes(),
    contextState: { contextAccount: rangeContext, authority: payer.address },
  });
  const transferLimitEqualityIxs = await verifyCiphertextCommitmentEquality({
    rpc: client.rpc, payer, proofData: authorization.transferEqualityProof,
    contextState: { contextAccount: transferLimitEqualityContext, authority: payer.address },
  });
  const periodLimitEqualityIxs = await verifyCiphertextCommitmentEquality({
    rpc: client.rpc, payer, proofData: authorization.periodEqualityProof,
    contextState: { contextAccount: periodLimitEqualityContext, authority: payer.address },
  });
  const limitRangeIxs = await verifyBatchedRangeProofU64({
    rpc: client.rpc, payer, proofData: authorization.rangeProof,
    contextState: { contextAccount: limitRangeContext, authority: payer.address },
  });

  await sendInstructions(client, payer, equalityIxs);
  await pause();
  await sendInstructions(client, payer, validityIxs);
  await pause();
  await sendInstructions(client, payer, rangeIxs.slice(0, -1));
  await pause();
  await sendInstructions(client, payer, rangeIxs.slice(-1));
  await pause();
  await sendInstructions(client, payer, transferLimitEqualityIxs);
  await pause();
  await sendInstructions(client, payer, periodLimitEqualityIxs);
  await pause();
  await sendInstructions(client, payer, limitRangeIxs.slice(0, -1));
  await pause();
  await sendInstructions(client, payer, limitRangeIxs.slice(-1));
  await pause();

  // The authority is the policy PDA, passed as a plain address with a
  // non-signer role. Nothing in this transaction can sign for it — that
  // signature only exists inside the program, once `invoke_signed` supplies
  // the seeds, and only after the limit check has passed.
  const transferIx = getConfidentialTransferInstruction({
    sourceToken: params.sourceToken,
    mint: params.mint,
    destinationToken: params.destinationToken,
    authority: params.policyAccount,
    equalityRecord: equalityContext.address,
    ciphertextValidityRecord: validityContext.address,
    rangeRecord: rangeContext.address,
    newSourceDecryptableAvailableBalance: params.senderKeys.ae
      .encrypt(proofs.remainingBalance)
      .toBytes() as never,
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
      buildAuthorizeConfidentialAndInvokeInstruction({
        policyAccount: params.policyAccount,
        agent: params.agent,
        targetProgram: TOKEN_2022_PROGRAM_ADDRESS,
        transferEqualityProof: transferLimitEqualityContext.address,
        periodEqualityProof: periodLimitEqualityContext.address,
        rangeProof: limitRangeContext.address,
        transferValidityProof: validityContext.address,
        instructionData: transferIx.data as Uint8Array,
        forwardedAccounts: transferIx.accounts.map((account) => ({
          address: account.address,
          role: account.role as 0 | 1 | 2 | 3,
        })),
      }),
      ...(params.additionalInstructions ?? []),
    ]);
    return { signature, remainingBalance: proofs.remainingBalance };
  } finally {
    await pause();
    try {
      await sendInstructions(client, payer, [
        closeContextStateProof({ contextState: equalityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: validityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: rangeContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: transferLimitEqualityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: periodLimitEqualityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: limitRangeContext.address, authority: payer, destination: payer.address }),
      ]);
    } catch (cause) {
      console.warn("context state cleanup failed (rent not reclaimed):", (cause as Error).message);
    }
  }
}
