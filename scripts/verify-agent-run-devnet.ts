import "../tests/setup-env.js";
import { generateKeyPairSigner } from "@solana/kit";
import { createDevnetClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { sendInstructions } from "../server/data/confidential-mint.js";
import {
  buildAuthorizeSpendV2Instruction,
  buildInitializePolicyV2Instruction,
  derivePolicyAddress,
  fetchPolicyV2Account,
} from "../server/data/policy-program-v2.js";
import { customErrorCode } from "../server/services/agent-run.js";

/**
 * The transaction shape the dashboard's run now depends on: owner pays the fee,
 * agent signs as the agent, both in one transaction.
 *
 * The owner here is a local keypair rather than a wallet extension, so this can
 * run headlessly. The transaction that reaches the cluster is the same either
 * way — two signatures, one of which must be the agent's — because the only
 * difference is which signer produces the fee payer's.
 *
 * Worth verifying separately because it is the part that makes the in-browser
 * run real rather than narrated, and because two-signer transactions are easy
 * to get subtly wrong — a policy that accepted the owner's signature in the
 * agent's place would look identical in the UI while enforcing nothing.
 *
 * That leaves exactly one thing unverified here: whether Phantom will sign a
 * transaction that already carries the agent's signature. Everything else on
 * this path is real.
 *
 * Run with: npm run verify-agent-run
 */

const MAX_PER_TRANSFER = 20_000_000n;
const MAX_PER_PERIOD = 30_000_000n;
const PERIOD_SECONDS = 3_600n;

const ERROR_EXCEEDS_PER_TRANSFER_LIMIT = 6001;
const ERROR_EXCEEDS_PERIOD_LIMIT = 6002;
const ERROR_ILLEGAL_SIGNER = 6003;

const results: { step: string; expected: string; observed: string; ok: boolean }[] = [];

function record(step: string, expected: string, observed: string, ok: boolean): void {
  results.push({ step, expected, observed, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n      expected: ${expected}\n      observed: ${observed}\n`);
}

async function main(): Promise<void> {
  const client = createDevnetClient();
  const owner = await loadOrCreatePayer();
  const agent = await generateKeyPairSigner();
  const impostor = await generateKeyPairSigner();

  console.log("owner:", owner.address);
  console.log("agent:", agent.address, "\n");

  const policyAccount = await derivePolicyAddress(owner.address, agent.address);
  await sendInstructions(client, owner, [
    buildInitializePolicyV2Instruction({
      policyAccount,
      owner,
      agent: agent.address,
      maxPerTransfer: MAX_PER_TRANSFER,
      maxPerPeriod: MAX_PER_PERIOD,
      periodSeconds: PERIOD_SECONDS,
    }),
  ]);

  // --- an in-policy payment is authorized by the chain --------------------
  const signature = await sendInstructions(client, owner, [
    buildAuthorizeSpendV2Instruction({ policyAccount, agent, amount: 4_200_000n }),
  ]);
  const afterFirst = await fetchPolicyV2Account(client, policyAccount);
  record(
    "owner pays the fee, agent signs as agent, and the program authorizes",
    "authorized, spent total = 4200000",
    `${signature.slice(0, 16)}…, spent = ${afterFirst?.spentInPeriod}`,
    afterFirst?.spentInPeriod === 4_200_000n,
  );

  // --- over the per-transfer limit ---------------------------------------
  let code: number | null = null;
  try {
    await sendInstructions(client, owner, [
      buildAuthorizeSpendV2Instruction({ policyAccount, agent, amount: 31_750_000n }),
    ]);
  } catch (error) {
    code = customErrorCode(error);
  }
  const afterOverLimit = await fetchPolicyV2Account(client, policyAccount);
  record(
    "an over-limit payment is refused by the program, not by the interface",
    `error ${ERROR_EXCEEDS_PER_TRANSFER_LIMIT}, spent total unchanged`,
    `error ${code}, spent = ${afterOverLimit?.spentInPeriod}`,
    code === ERROR_EXCEEDS_PER_TRANSFER_LIMIT && afterOverLimit?.spentInPeriod === 4_200_000n,
  );

  // --- the period budget accumulates on-chain ----------------------------
  await sendInstructions(client, owner, [
    buildAuthorizeSpendV2Instruction({ policyAccount, agent, amount: 20_000_000n }),
  ]);
  let periodCode: number | null = null;
  try {
    await sendInstructions(client, owner, [
      buildAuthorizeSpendV2Instruction({ policyAccount, agent, amount: 20_000_000n }),
    ]);
  } catch (error) {
    periodCode = customErrorCode(error);
  }
  record(
    "each payment is individually fine but the period budget still runs out",
    `error ${ERROR_EXCEEDS_PERIOD_LIMIT}`,
    `error ${periodCode}`,
    periodCode === ERROR_EXCEEDS_PERIOD_LIMIT,
  );

  // --- the owner cannot spend as their own agent -------------------------
  // The whole two-signature design rests on this: if the fee payer's signature
  // could stand in for the agent's, the run would look identical while
  // enforcing nothing at all.
  let impostorCode: number | null = null;
  try {
    await sendInstructions(client, owner, [
      buildAuthorizeSpendV2Instruction({ policyAccount, agent: impostor, amount: 1_000_000n }),
    ]);
  } catch (error) {
    impostorCode = customErrorCode(error);
  }
  record(
    "a different key cannot sign in the agent's place",
    `error ${ERROR_ILLEGAL_SIGNER}`,
    `error ${impostorCode}`,
    impostorCode === ERROR_ILLEGAL_SIGNER,
  );

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    throw new Error(`${failed.length} check(s) failed: ${failed.map((f) => f.step).join("; ")}`);
  }
  console.log(
    "\nALL CHECKS PASSED: the dashboard's run signs real transactions, and the refusals come from",
    "\nthe deployed program rather than from local JavaScript.",
  );
}

await main();
