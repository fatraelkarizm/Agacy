import "../tests/setup-env.js";
import { writeFileSync } from "node:fs";
import { address, generateKeyPairSigner, type Address } from "@solana/kit";
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  getConfidentialTransferInstruction,
  getSetAuthorityInstruction,
} from "@solana-program/token-2022";
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
  closeContextStateProof,
} from "@solana-program/zk-elgamal-proof";
import { ElGamalPubkey } from "@solana/zk-sdk/node";
import { createDevnetClient, type SolanaClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { createConfidentialMint, sendInstructions } from "../server/data/confidential-mint.js";
import { createConfidentialTokenAccount } from "../server/data/confidential-account.js";
import { deriveConfidentialKeys } from "../server/data/confidential-keys.js";
import {
  depositToConfidentialBalance,
  applyPendingBalance,
} from "../server/data/confidential-transfer.js";
import { fetchConfidentialBalance } from "../server/data/confidential-balance.js";
import { generateTransferProofs } from "../server/data/confidential-proofs.js";
import { extractHandleCiphertext } from "../server/data/elgamal-arithmetic.js";
import {
  POLICY_V2_PROGRAM_ID,
  buildAssumeCustodyInstruction,
  buildAuthorizeAndInvokeInstruction,
  buildInitializePolicyV2Instruction,
  buildReleaseCustodyInstruction,
  derivePolicyAddress,
  fetchPolicyV2Account,
} from "../server/data/policy-program-v2.js";

/**
 * The owner-PDA custody model, end to end, against live devnet.
 *
 * This script exists because of a confirmed negative:
 * `verify-confidential-delegate-devnet.ts` proved on real devnet that
 * Token-2022's confidential `Transfer` ignores delegate authority entirely
 * (`OwnerMismatch`, even with `delegatedAmount = u64::MAX`). Delegation — the
 * mechanism `verify-delegate-binding-devnet.ts` proved works for classic SPL
 * Token — simply cannot bind a confidential transfer. The only remaining path
 * was to make the policy PDA the token account's actual *owner*.
 *
 * That change is strictly more powerful and strictly more dangerous, so this
 * script deliberately spends more of its length on the dangers than on the
 * happy path. In order:
 *
 *   1. custody is really taken — read the token account's `owner` field back
 *      from chain, not our own state
 *   2. the agent tries to steal the account outright with one unit of its
 *      spend budget, and fails
 *   3. a real confidential transfer moves real value through the policy —
 *      the thing delegation could not do
 *   4. an over-limit transfer is refused by the running program
 *   5. the owner takes the account back unconditionally, with the spend
 *      budget exhausted, and can use it directly again afterwards
 *
 * Every claim is checked by reading chain state or decrypting a real balance.
 * Nothing here is asserted from a return value alone.
 *
 * Run with: npm run verify-custody
 */

const AccountRole = { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 } as const;
const AUDITOR_HANDLE_INDEX = 2;

const DECIMALS = 6;
const DEPOSIT = 10_000_000n;
const MAX_PER_TRANSFER = 4_000_000n;
const MAX_PER_PERIOD = 6_000_000n;
const PERIOD_SECONDS = 3_600n;
const TRANSFER = 2_500_000n;
const OVER_LIMIT = MAX_PER_TRANSFER + 1n;

const pause = () => new Promise((resolve) => setTimeout(resolve, 3_000));

/**
 * Anchor numbers custom errors from 6000 in declaration order — these must
 * match programs/agacy_policy_v2/src/error.rs.
 *
 * Asserting the specific code matters more than it looks: "the transaction
 * failed" is satisfied by a typo in an account list just as easily as by the
 * guard doing its job, and a test that passes for the wrong reason is worse
 * than no test. These two are the ones this whole design rests on.
 */
const ERROR_EXCEEDS_PER_TRANSFER_LIMIT = 6001;
const ERROR_FORBIDDEN_CPI_INSTRUCTION = 6007;

/**
 * Digs the on-chain custom error number out of whatever the RPC layer wrapped
 * it in. Simulation failures surface it in the program logs as a hex code;
 * preflight-rejected sends surface it as structured context. Both are checked
 * rather than assuming one shape.
 */
function customErrorCode(error: unknown): number | null {
  const structured = (error as { cause?: { context?: { code?: number } } })?.cause?.context?.code;
  if (typeof structured === "number") return structured;

  const text = JSON.stringify(error, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  ) + String((error as Error)?.message ?? "");

  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex?.[1]) return Number.parseInt(hex[1], 16);

  const decimal = text.match(/"Custom"\s*:\s*(\d+)/);
  if (decimal?.[1]) return Number.parseInt(decimal[1], 10);

  return null;
}

const results: { step: string; expected: string; observed: string; ok: boolean }[] = [];

function record(step: string, expected: string, observed: string, ok: boolean): void {
  results.push({ step, expected, observed, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n      expected: ${expected}\n      observed: ${observed}\n`);
}

async function tokenAccountOwner(client: SolanaClient, tokenAccount: Address): Promise<string> {
  const account = await fetchToken(client.rpc, tokenAccount);
  return account.data.owner;
}

async function main(): Promise<void> {
  const client = createDevnetClient();
  const payer = await loadOrCreatePayer();

  const senderKeys = deriveConfidentialKeys(new Uint8Array(64).fill(77));
  const recipientKeys = deriveConfidentialKeys(new Uint8Array(64).fill(88));
  const recipientOwner = await generateKeyPairSigner();
  const agent = await generateKeyPairSigner();

  console.log("program:", POLICY_V2_PROGRAM_ID);
  console.log("owner:", payer.address);
  console.log("agent:", agent.address, "\n");

  const { mint } = await createConfidentialMint(client, payer, {
    decimals: DECIMALS,
    authority: payer.address,
    autoApproveNewAccounts: true,
  });

  const { tokenAccount: senderAccount } = await createConfidentialTokenAccount(
    client, payer, payer, mint, senderKeys,
  );
  const { tokenAccount: recipientAccount } = await createConfidentialTokenAccount(
    client, payer, recipientOwner, mint, recipientKeys,
  );

  // Funded before custody deliberately: `Deposit` is an owner-authority
  // instruction, so after handover it would have to be routed through
  // `custody_maintenance` too. Keeping setup on the ordinary path makes the
  // custody assertions below about custody, not about setup plumbing.
  await depositToConfidentialBalance(client, payer, payer, {
    tokenAccount: senderAccount, mint, owner: payer, amount: DEPOSIT, decimals: DECIMALS,
  });
  await applyPendingBalance(client, payer, {
    tokenAccount: senderAccount, owner: payer, keys: senderKeys,
    newAvailableBalance: DEPOSIT, expectedPendingCreditCounter: 1n,
  });
  console.log(`mint: ${mint}\nagent account: ${senderAccount}\nvendor account: ${recipientAccount}`);
  console.log(`agent account funded with ${DEPOSIT} confidential base units.\n`);

  // --- 1. provision the policy ------------------------------------------
  const policyAccount = await derivePolicyAddress(payer.address, agent.address);
  await sendInstructions(client, payer, [
    buildInitializePolicyV2Instruction({
      policyAccount,
      owner: payer,
      agent: agent.address,
      maxPerTransfer: MAX_PER_TRANSFER,
      maxPerPeriod: MAX_PER_PERIOD,
      periodSeconds: PERIOD_SECONDS,
    }),
  ]);
  const provisioned = await fetchPolicyV2Account(client, policyAccount);
  record(
    "policy provisioned as a PDA the program can sign for",
    `owner=${payer.address} agent=${agent.address} custody=none`,
    `owner=${provisioned?.owner} agent=${provisioned?.agent} custody=${provisioned?.custodiedTokenAccount ?? "none"}`,
    provisioned?.owner === payer.address
      && provisioned?.agent === agent.address
      && provisioned?.custodiedTokenAccount === null,
  );

  // --- 2. take custody ---------------------------------------------------
  const ownerBeforeCustody = await tokenAccountOwner(client, senderAccount);
  const custodySignature = await sendInstructions(client, payer, [
    buildAssumeCustodyInstruction({
      policyAccount,
      owner: payer,
      tokenAccount: senderAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ]);
  const ownerAfterCustody = await tokenAccountOwner(client, senderAccount);
  const custodied = await fetchPolicyV2Account(client, policyAccount);
  record(
    "the token account's real on-chain owner is now the policy PDA",
    `${policyAccount} (was ${ownerBeforeCustody})`,
    ownerAfterCustody,
    ownerAfterCustody === policyAccount && custodied?.custodiedTokenAccount === senderAccount,
  );

  // --- 3. the theft attempt ----------------------------------------------
  // One unit of spend budget, spent on SetAuthority instead of a transfer.
  // Before the CPI allowlist existed this succeeded and handed the agent the
  // whole account, permanently, for a rounding error's worth of allowance.
  const theftIx = getSetAuthorityInstruction(
    {
      owned: senderAccount,
      owner: policyAccount,
      authorityType: AuthorityType.AccountOwner,
      newAuthority: agent.address,
    },
    { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
  );
  let theftCode: number | null = null;
  let theftSucceeded = false;
  try {
    await sendInstructions(client, payer, [
      buildAuthorizeAndInvokeInstruction({
        policyAccount,
        agent,
        targetProgram: TOKEN_2022_PROGRAM_ADDRESS,
        amount: 1n,
        instructionData: theftIx.data,
        forwardedAccounts: theftIx.accounts.map((account) => ({
          address: account.address,
          role: AccountRole.WRITABLE,
        })),
      }),
    ]);
    theftSucceeded = true;
  } catch (error) {
    theftCode = customErrorCode(error);
  }
  const ownerAfterTheft = await tokenAccountOwner(client, senderAccount);
  record(
    "the agent cannot buy the account with one unit of its budget",
    `rejected with ForbiddenCpiInstruction (${ERROR_FORBIDDEN_CPI_INSTRUCTION}), account still owned by the policy PDA`,
    `${theftSucceeded ? "SUCCEEDED" : `error ${theftCode}`} | owner=${ownerAfterTheft}`,
    !theftSucceeded
      && theftCode === ERROR_FORBIDDEN_CPI_INSTRUCTION
      && ownerAfterTheft === policyAccount,
  );

  // --- 4. a real confidential transfer, through the policy ---------------
  const senderBefore = await fetchConfidentialBalance(client, senderAccount, senderKeys);
  const transferSignature = await policyGatedConfidentialTransfer(client, payer, agent, {
    policyAccount,
    sourceToken: senderAccount,
    destinationToken: recipientAccount,
    mint,
    senderKeys,
    recipientElGamalPubkey: recipientKeys.elGamal.pubkey(),
    availableBalance: senderBefore.availableBalance,
    availableBalanceCiphertext: senderBefore.availableBalanceCiphertext,
    amount: TRANSFER,
  });

  const senderAfter = await fetchConfidentialBalance(client, senderAccount, senderKeys);
  await applyPendingBalance(client, payer, {
    tokenAccount: recipientAccount, owner: recipientOwner, keys: recipientKeys,
    newAvailableBalance: TRANSFER, expectedPendingCreditCounter: 1n,
  });
  const recipientAfter = await fetchConfidentialBalance(client, recipientAccount, recipientKeys);
  record(
    "a real Token-2022 confidential transfer moved value with the policy PDA as authority",
    `sender ${DEPOSIT - TRANSFER}, vendor ${TRANSFER} (both decrypted from chain)`,
    `sender ${senderAfter.availableBalance}, vendor ${recipientAfter.availableBalance}`,
    senderAfter.availableBalance === DEPOSIT - TRANSFER
      && recipientAfter.availableBalance === TRANSFER,
  );

  const afterSpend = await fetchPolicyV2Account(client, policyAccount);
  record(
    "the transfer was charged against the period budget",
    `${TRANSFER} of ${MAX_PER_PERIOD}`,
    `${afterSpend?.spentInPeriod} of ${afterSpend?.maxPerPeriod}`,
    afterSpend?.spentInPeriod === TRANSFER,
  );

  // --- 5. over the per-transfer limit ------------------------------------
  // Rejected on the policy check, before any proof accounts matter, so this
  // does not need a full proof set to be a real test of the limit.
  let overLimitCode: number | null = null;
  let overLimitSucceeded = false;
  try {
    await sendInstructions(client, payer, [
      buildAuthorizeAndInvokeInstruction({
        policyAccount,
        agent,
        targetProgram: TOKEN_2022_PROGRAM_ADDRESS,
        amount: OVER_LIMIT,
        instructionData: new Uint8Array([27, 7]),
        forwardedAccounts: [{ address: senderAccount, role: AccountRole.WRITABLE }],
      }),
    ]);
    overLimitSucceeded = true;
  } catch (error) {
    overLimitCode = customErrorCode(error);
  }
  const afterOverLimit = await fetchPolicyV2Account(client, policyAccount);
  record(
    "an over-limit transfer is refused by the running program",
    `${OVER_LIMIT} rejected with ExceedsPerTransferLimit (${ERROR_EXCEEDS_PER_TRANSFER_LIMIT}), period total unchanged at ${TRANSFER}`,
    `${overLimitSucceeded ? "SUCCEEDED" : `error ${overLimitCode}`} | spent=${afterOverLimit?.spentInPeriod}`,
    !overLimitSucceeded
      && overLimitCode === ERROR_EXCEEDS_PER_TRANSFER_LIMIT
      && afterOverLimit?.spentInPeriod === TRANSFER,
  );

  // --- 6. the recovery hatch ---------------------------------------------
  const releaseSignature = await sendInstructions(client, payer, [
    buildReleaseCustodyInstruction({
      policyAccount,
      owner: payer,
      tokenAccount: senderAccount,
      newAuthority: payer.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ]);
  const ownerAfterRelease = await tokenAccountOwner(client, senderAccount);
  const released = await fetchPolicyV2Account(client, policyAccount);
  record(
    "the owner can take the account back, unconditionally",
    `${payer.address}, policy record cleared`,
    `${ownerAfterRelease}, record=${released?.custodiedTokenAccount ?? "cleared"}`,
    ownerAfterRelease === payer.address && released?.custodiedTokenAccount === null,
  );

  // Getting the owner field back is only half of it. The recovery hatch is
  // worth nothing unless the owner can actually act on the account again
  // with no involvement from this program at all.
  await depositToConfidentialBalance(client, payer, payer, {
    tokenAccount: senderAccount, mint, owner: payer, amount: 1_000_000n, decimals: DECIMALS,
  });
  await applyPendingBalance(client, payer, {
    tokenAccount: senderAccount, owner: payer, keys: senderKeys,
    newAvailableBalance: senderAfter.availableBalance + 1_000_000n,
    expectedPendingCreditCounter: 1n,
  });
  const recovered = await fetchConfidentialBalance(client, senderAccount, senderKeys);
  record(
    "and the recovered account is genuinely usable by its owner again",
    `${senderAfter.availableBalance + 1_000_000n} after an owner-signed deposit`,
    `${recovered.availableBalance}`,
    recovered.availableBalance === senderAfter.availableBalance + 1_000_000n,
  );

  const proof = {
    capturedAt: new Date().toISOString(),
    cluster: "devnet",
    programId: POLICY_V2_PROGRAM_ID,
    ownerAddress: payer.address,
    agentAddress: agent.address,
    policyAccount,
    mint,
    custodiedTokenAccount: senderAccount,
    vendorAccount: recipientAccount,
    policy: {
      maxPerTransfer: MAX_PER_TRANSFER.toString(),
      maxPerPeriod: MAX_PER_PERIOD.toString(),
      periodSeconds: PERIOD_SECONDS.toString(),
    },
    signatures: {
      assumeCustody: custodySignature,
      confidentialTransfer: transferSignature,
      releaseCustody: releaseSignature,
    },
    transferredAmount: TRANSFER.toString(),
    checks: results,
  };
  writeFileSync("server/data/custody-proof.json", `${JSON.stringify(proof, null, 2)}\n`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log("saved -> server/data/custody-proof.json");
  if (failed.length > 0) {
    throw new Error(`${failed.length} check(s) failed: ${failed.map((f) => f.step).join("; ")}`);
  }
  console.log(
    "\nALL CHECKS PASSED: the policy program owns a real Token-2022 confidential account on devnet,",
    "\nmoved real value through it under a real spend limit, refused both an over-limit transfer and",
    "\nan attempt to seize the account outright — and handed it back to its owner on demand.",
  );
}

interface PolicyGatedTransferParams {
  readonly policyAccount: Address;
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
}

/**
 * Builds a real confidential-transfer proof set — identical math to an
 * ordinary transfer, see confidential-transfer.ts — then submits the transfer
 * through `authorize_and_invoke` with the policy PDA as its authority, rather
 * than sending it directly as the owner.
 *
 * The authority is passed as a bare address with a non-signer role on
 * purpose. Nothing in this transaction can sign for a PDA; that signature
 * only comes into existence inside the program, when `invoke_signed` supplies
 * the seeds.
 */
async function policyGatedConfidentialTransfer(
  client: SolanaClient,
  payer: Awaited<ReturnType<typeof loadOrCreatePayer>>,
  agent: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  params: PolicyGatedTransferParams,
): Promise<string> {
  const auditorPubkey = ElGamalPubkey.fromBytes(new Uint8Array(32));

  const proofs = generateTransferProofs({
    senderKeypair: params.senderKeys.elGamal,
    recipientPubkey: params.recipientElGamalPubkey,
    auditorPubkey,
    availableBalance: params.availableBalance,
    amount: params.amount,
    availableBalanceCiphertext: params.availableBalanceCiphertext,
  });

  const equalityContext = await generateKeyPairSigner();
  const validityContext = await generateKeyPairSigner();
  const rangeContext = await generateKeyPairSigner();

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

  await sendInstructions(client, payer, equalityIxs);
  await pause();
  await sendInstructions(client, payer, validityIxs);
  await pause();
  await sendInstructions(client, payer, rangeIxs.slice(0, -1));
  await pause();
  await sendInstructions(client, payer, rangeIxs.slice(-1));
  await pause();

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
    return await sendInstructions(client, payer, [
      buildAuthorizeAndInvokeInstruction({
        policyAccount: params.policyAccount,
        agent,
        targetProgram: TOKEN_2022_PROGRAM_ADDRESS,
        amount: params.amount,
        instructionData: transferIx.data,
        forwardedAccounts: transferIx.accounts.map((account) => ({
          address: account.address,
          role: account.role as 0 | 1 | 2 | 3,
        })),
      }),
    ]);
  } finally {
    await pause();
    try {
      await sendInstructions(client, payer, [
        closeContextStateProof({ contextState: equalityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: validityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: rangeContext.address, authority: payer, destination: payer.address }),
      ]);
    } catch (cause) {
      console.warn("context state cleanup failed (rent not reclaimed):", (cause as Error).message);
    }
  }
}

await main();
