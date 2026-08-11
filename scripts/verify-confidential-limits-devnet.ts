import "../tests/setup-env.js";
import { writeFileSync } from "node:fs";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { ElGamalKeypair } from "@solana/zk-sdk/node";
import {
  verifyBatchedRangeProofU64,
  verifyCiphertextCommitmentEquality,
  closeContextStateProof,
} from "@solana-program/zk-elgamal-proof";
import { createDevnetClient, type SolanaClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { sendInstructions } from "../server/data/confidential-mint.js";
import {
  buildAuthorizeConfidentialInstruction,
  buildAuthorizeSpendV2Instruction,
  buildInitializeConfidentialPolicyV2Instruction,
  derivePolicyAddress,
  fetchPolicyV2Account,
  POLICY_V2_PROGRAM_ID,
} from "../server/data/policy-program-v2.js";
import {
  buildConfidentialAuthorization,
  encryptLimit,
  encryptedZero,
} from "../server/data/confidential-limits.js";

/**
 * Confidential spend limits, end to end on live devnet.
 *
 * The claim under test is narrow and precise: the policy program enforces a
 * spend limit it is never able to read. Not "the limit is obfuscated" — the
 * program genuinely holds only ciphertexts, does homomorphic arithmetic on
 * them, and refuses anything not backed by a proof produced by Solana's own
 * ZK ElGamal Proof program.
 *
 * Most of this script is about the ways that could be faked, because a check
 * that only ever sees the happy path proves very little:
 *
 *   - the limit really is unreadable in the account bytes
 *   - an in-policy spend is authorized, and the encrypted running total moves
 *   - an over-limit spend has no provable statement at all
 *   - **proofs built for a smaller amount cannot be replayed against a larger
 *     one** — the sharpest test here, because it is what distinguishes a
 *     program that recomputes from one that trusts its caller
 *   - a fabricated "proof" account is refused for not coming from the verifier
 *   - the old plaintext path refuses rather than enforcing a stale number
 *
 * Run with: npm run verify-confidential-limits
 */

const DECIMALS_SCALE = 1_000_000n;
const MAX_PER_TRANSFER = 20n * DECIMALS_SCALE;
const MAX_PER_PERIOD = 50n * DECIMALS_SCALE;
const PERIOD_SECONDS = 3_600n;
const IN_POLICY_AMOUNT = 5n * DECIMALS_SCALE;
const OVER_LIMIT_AMOUNT = 25n * DECIMALS_SCALE;

const ERROR_EXCEEDS_PER_TRANSFER_LIMIT = 6001;
const ERROR_PROOF_ACCOUNT_NOT_FROM_VERIFIER = 6013;
const ERROR_PROOF_DOES_NOT_COVER_THIS_STATEMENT = 6017;
const ERROR_CONFIDENTIAL_LIMITS_REQUIRED = 6019;

const pause = () => new Promise((resolve) => setTimeout(resolve, 2_000));

const results: { step: string; expected: string; observed: string; ok: boolean }[] = [];

function record(step: string, expected: string, observed: string, ok: boolean): void {
  results.push({ step, expected, observed, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n      expected: ${expected}\n      observed: ${observed}\n`);
}

function customErrorCode(error: unknown): number | null {
  const structured = (error as { cause?: { context?: { code?: number } } })?.cause?.context?.code;
  if (typeof structured === "number") return structured;
  const text =
    JSON.stringify(error, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) +
    String((error as Error)?.message ?? "");
  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex?.[1]) return Number.parseInt(hex[1], 16);
  const decimal = text.match(/"Custom"\s*:\s*(\d+)/);
  if (decimal?.[1]) return Number.parseInt(decimal[1], 10);
  return null;
}

/** Publish one proof into its own context state account and return its address. */
async function publishProof(
  client: SolanaClient,
  payer: Awaited<ReturnType<typeof loadOrCreatePayer>>,
  kind: "equality" | "range",
  proofData: Uint8Array,
): Promise<Address> {
  const contextAccount = await generateKeyPairSigner();
  const contextState = { contextAccount, authority: payer.address };

  const instructions =
    kind === "equality"
      ? await verifyCiphertextCommitmentEquality({ rpc: client.rpc, payer, proofData, contextState })
      : await verifyBatchedRangeProofU64({ rpc: client.rpc, payer, proofData, contextState });

  // Larger proofs come back split across instructions that must land in
  // separate transactions; sending the tail last matches the pattern the
  // confidential-transfer scripts already use.
  if (instructions.length > 1) {
    await sendInstructions(client, payer, instructions.slice(0, -1));
    await pause();
    await sendInstructions(client, payer, instructions.slice(-1));
  } else {
    await sendInstructions(client, payer, instructions);
  }
  await pause();

  return contextAccount.address;
}

async function main(): Promise<void> {
  const client = createDevnetClient();
  const payer = await loadOrCreatePayer();
  const agent = await generateKeyPairSigner();

  // The key the limits live under. Whoever holds it can read the budget —
  // by design that is the owner and their agent, and nobody else.
  const limitKeys = new ElGamalKeypair();
  const limitPubkey = limitKeys.pubkey().toBytes();

  console.log("program:", POLICY_V2_PROGRAM_ID);
  console.log("owner:", payer.address);
  console.log("agent:", agent.address, "\n");

  const policyAccount = await derivePolicyAddress(payer.address, agent.address);
  const maxPerTransferCt = encryptLimit(limitKeys, MAX_PER_TRANSFER);
  const maxPerPeriodCt = encryptLimit(limitKeys, MAX_PER_PERIOD);
  const initializeInstruction = buildInitializeConfidentialPolicyV2Instruction({
    policyAccount,
    owner: payer,
    agent: agent.address,
    limitPubkey,
    maxPerTransferCt,
    maxPerPeriodCt,
    periodSeconds: PERIOD_SECONDS,
  });
  const initializeSignature = await sendInstructions(client, payer, [initializeInstruction]);
  await pause();

  const initializeTransaction = await client.rpc
    .getTransaction(initializeSignature as never, {
      commitment: "confirmed",
      encoding: "base64",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  const initializeTransactionBytes = Buffer.from(
    (initializeTransaction as { transaction: [string, string] }).transaction[0],
    "base64",
  );

  const stored = await fetchPolicyV2Account(client, policyAccount);
  record(
    "the policy now carries encrypted limits instead of readable ones",
    "confidential limits present, under the owner's ElGamal key",
    stored?.confidentialLimits
      ? `present (pubkey ${Buffer.from(stored.confidentialLimits.limitPubkey).toString("hex").slice(0, 12)}…)`
      : "absent",
    stored?.confidentialLimits !== null
      && Buffer.from(stored?.confidentialLimits?.limitPubkey ?? []).equals(Buffer.from(limitPubkey)),
  );

  // --- 2. the limit is genuinely not readable on-chain --------------------
  // A limit stored in the clear would appear as its little-endian u64 somewhere
  // in the account. This searches the raw account bytes for exactly that.
  const rawAccount = await client.rpc
    .getAccountInfo(policyAccount, { commitment: "confirmed", encoding: "base64" })
    .send();
  const accountBytes = Buffer.from(rawAccount.value?.data[0] ?? "", "base64");
  const limitLittleEndian = Buffer.alloc(8);
  limitLittleEndian.writeBigUInt64LE(MAX_PER_TRANSFER);
  const foundInAccount = accountBytes.includes(limitLittleEndian);
  const foundInInitializeTransaction = initializeTransactionBytes.includes(limitLittleEndian);
  record(
    "the limit never appears in the policy account or confirmed initialize transaction",
    "20000000 absent from all account bytes and serialized transaction bytes",
    foundInAccount || foundInInitializeTransaction
      ? `FOUND IN PLAINTEXT (${foundInAccount ? "account" : "transaction"})`
      : "not found — confidential from genesis",
    !foundInAccount && !foundInInitializeTransaction,
  );

  // --- 3. an in-policy spend is authorized --------------------------------
  const authorization = buildConfidentialAuthorization(
    limitKeys,
    { maxPerTransferCt, maxPerPeriodCt, spentInPeriodCt: encryptedZero() },
    { maxPerTransfer: MAX_PER_TRANSFER, maxPerPeriod: MAX_PER_PERIOD, spentInPeriod: 0n },
    IN_POLICY_AMOUNT,
  );

  const transferEqualityProof = await publishProof(client, payer, "equality", authorization.transferEqualityProof);
  const periodEqualityProof = await publishProof(client, payer, "equality", authorization.periodEqualityProof);
  const rangeProof = await publishProof(client, payer, "range", authorization.rangeProof);

  const authorizeSignature = await sendInstructions(client, payer, [
    buildAuthorizeConfidentialInstruction({
      policyAccount,
      agent,
      amountCiphertext: authorization.amountCiphertext,
      transferEqualityProof,
      periodEqualityProof,
      rangeProof,
    }),
  ]);
  await pause();

  const afterSpend = await fetchPolicyV2Account(client, policyAccount);
  const spentChanged = !Buffer.from(afterSpend?.confidentialLimits?.spentInPeriodCt ?? []).equals(
    Buffer.from(encryptedZero()),
  );
  record(
    "an in-policy spend is authorized against limits the program cannot read",
    "authorized, and the encrypted period total moves off zero",
    `authorized (${authorizeSignature.slice(0, 16)}…), spent-total changed: ${spentChanged}`,
    spentChanged,
  );

  // --- 4. an over-limit spend has no provable statement -------------------
  let clientRefusal = "";
  try {
    buildConfidentialAuthorization(
      limitKeys,
      { maxPerTransferCt, maxPerPeriodCt, spentInPeriodCt: encryptedZero() },
      { maxPerTransfer: MAX_PER_TRANSFER, maxPerPeriod: MAX_PER_PERIOD, spentInPeriod: 0n },
      OVER_LIMIT_AMOUNT,
    );
    clientRefusal = "PROOF WAS PRODUCED";
  } catch (error) {
    clientRefusal = (error as Error).message.slice(0, 60);
  }
  record(
    "an over-limit spend cannot even be given a proof",
    "proof generation refuses — the statement is false, so no proof exists",
    clientRefusal,
    clientRefusal !== "PROOF WAS PRODUCED",
  );

  // --- 5. the sharp one: proofs for a small amount, replayed on a big one --
  // Everything here is a valid, verifier-accepted proof. It simply describes a
  // different spend than the one being attempted. A program that took the
  // caller's word for the difference would accept this.
  const replay = buildConfidentialAuthorization(
    limitKeys,
    { maxPerTransferCt, maxPerPeriodCt, spentInPeriodCt: afterSpend!.confidentialLimits!.spentInPeriodCt },
    {
      maxPerTransfer: MAX_PER_TRANSFER,
      maxPerPeriod: MAX_PER_PERIOD,
      spentInPeriod: IN_POLICY_AMOUNT,
    },
    1n * DECIMALS_SCALE,
  );
  const replayTransfer = await publishProof(client, payer, "equality", replay.transferEqualityProof);
  const replayPeriod = await publishProof(client, payer, "equality", replay.periodEqualityProof);
  const replayRange = await publishProof(client, payer, "range", replay.rangeProof);

  const bigAmountCiphertext = limitKeys.pubkey().encryptU64(OVER_LIMIT_AMOUNT).toBytes();
  let replayCode: number | null = null;
  let replaySucceeded = false;
  try {
    await sendInstructions(client, payer, [
      buildAuthorizeConfidentialInstruction({
        policyAccount,
        agent,
        amountCiphertext: bigAmountCiphertext,
        transferEqualityProof: replayTransfer,
        periodEqualityProof: replayPeriod,
        rangeProof: replayRange,
      }),
    ]);
    replaySucceeded = true;
  } catch (error) {
    replayCode = customErrorCode(error);
  }
  record(
    "valid proofs for a 1-token spend cannot be replayed to authorize a 25-token one",
    `rejected with ProofDoesNotCoverThisStatement (${ERROR_PROOF_DOES_NOT_COVER_THIS_STATEMENT})`,
    replaySucceeded ? "AUTHORIZED — the program trusted the caller" : `error ${replayCode}`,
    !replaySucceeded && replayCode === ERROR_PROOF_DOES_NOT_COVER_THIS_STATEMENT,
  );
  await pause();

  // --- 6. a fabricated proof account is refused ---------------------------
  // The policy account itself is a real account full of real bytes — and is
  // emphatically not the verifier's output.
  let forgedCode: number | null = null;
  let forgedSucceeded = false;
  try {
    await sendInstructions(client, payer, [
      buildAuthorizeConfidentialInstruction({
        policyAccount,
        agent,
        amountCiphertext: authorization.amountCiphertext,
        transferEqualityProof: policyAccount,
        periodEqualityProof: policyAccount,
        rangeProof: policyAccount,
      }),
    ]);
    forgedSucceeded = true;
  } catch (error) {
    forgedCode = customErrorCode(error);
  }
  record(
    "an account that is not the verifier's output is refused as a proof",
    `rejected with ProofAccountNotFromVerifier (${ERROR_PROOF_ACCOUNT_NOT_FROM_VERIFIER})`,
    forgedSucceeded ? "AUTHORIZED — proofs were never checked" : `error ${forgedCode}`,
    !forgedSucceeded && forgedCode === ERROR_PROOF_ACCOUNT_NOT_FROM_VERIFIER,
  );
  await pause();

  // --- 7. the plaintext path closes rather than enforcing a stale number ---
  let plaintextCode: number | null = null;
  let plaintextSucceeded = false;
  try {
    await sendInstructions(client, payer, [
      buildAuthorizeSpendV2Instruction({ policyAccount, agent, amount: 1n }),
    ]);
    plaintextSucceeded = true;
  } catch (error) {
    plaintextCode = customErrorCode(error);
  }
  record(
    "the old plaintext limit path refuses instead of enforcing a stale copy",
    `rejected with ConfidentialLimitsRequired (${ERROR_CONFIDENTIAL_LIMITS_REQUIRED})`,
    plaintextSucceeded ? "AUTHORIZED against stale plaintext limits" : `error ${plaintextCode}`,
    !plaintextSucceeded && plaintextCode === ERROR_CONFIDENTIAL_LIMITS_REQUIRED,
  );

  const proof = {
    capturedAt: new Date().toISOString(),
    cluster: "devnet",
    programId: POLICY_V2_PROGRAM_ID,
    ownerAddress: payer.address,
    agentAddress: agent.address,
    policyAccount,
    initializeSignature,
    limits: {
      maxPerTransfer: MAX_PER_TRANSFER.toString(),
      maxPerPeriod: MAX_PER_PERIOD.toString(),
      note: "Recorded here for the reader only. On-chain these exist solely as ciphertexts.",
    },
    authorizeSignature,
    checks: results,
  };
  writeFileSync("server/data/confidential-limits-proof.json", `${JSON.stringify(proof, null, 2)}\n`);

  // Reclaim the rent on every context account this run created.
  await pause();
  for (const context of [transferEqualityProof, periodEqualityProof, rangeProof, replayTransfer, replayPeriod, replayRange]) {
    try {
      await sendInstructions(client, payer, [
        closeContextStateProof({ contextState: context, authority: payer, destination: payer.address }),
      ]);
    } catch {
      console.warn("context cleanup failed (rent not reclaimed):", context);
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log("saved -> server/data/confidential-limits-proof.json");
  if (failed.length > 0) {
    throw new Error(`${failed.length} check(s) failed: ${failed.map((f) => f.step).join("; ")}`);
  }
  console.log(
    "\nALL CHECKS PASSED: the spend limit is enforced on live devnet by a program that never learns it.",
  );
}

await main();
