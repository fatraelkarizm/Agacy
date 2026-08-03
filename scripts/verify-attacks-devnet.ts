import "../tests/setup-env.js";
import { generateKeyPairSigner } from "@solana/kit";
import { createDevnetClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { sendInstructions } from "../server/data/confidential-mint.js";
import {
  buildAuthorizeSpendV2Instruction,
  buildInitializePolicyV2Instruction,
  buildUpdateLimitsV2Instruction,
  derivePolicyAddress,
  fetchPolicyV2Account,
} from "../server/data/policy-program-v2.js";
import { customErrorCode } from "../server/services/agent-run.js";
import { ATTACKS } from "../server/services/agent-attacks.js";

/**
 * Every attack the dashboard offers, run for real against devnet.
 *
 * The dashboard version runs through a wallet, which cannot be driven
 * headlessly. This runs the identical instructions with a local keypair so the
 * outcomes are verified before any of it is put behind a button — a "blocked"
 * badge that was never actually tested would be the worst thing on the page.
 *
 * Run with: npm run verify-attacks
 */

const MAX_PER_TRANSFER = 20_000_000n;
const MAX_PER_PERIOD = 50_000_000n;
const PERIOD_SECONDS = 3_600n;

const results: { step: string; expected: string; observed: string; ok: boolean }[] = [];

function record(step: string, expected: string, observed: string, ok: boolean): void {
  results.push({ step, expected, observed, ok });
  console.log(`${ok ? "BLOCKED " : "BREACHED"}  ${step}\n      expected: ${expected}\n      observed: ${observed}\n`);
}

function expectationFor(id: string): number {
  const attack = ATTACKS.find((candidate) => candidate.id === id);
  if (!attack) throw new Error(`No attack defined with id ${id}`);
  return attack.expectedError;
}

async function attempt(run: () => Promise<unknown>): Promise<number | "succeeded"> {
  try {
    await run();
    return "succeeded";
  } catch (error) {
    const code = customErrorCode(error);
    if (code === null) throw error;
    return code;
  }
}

async function main(): Promise<void> {
  const client = createDevnetClient();
  const owner = await loadOrCreatePayer();
  const agent = await generateKeyPairSigner();
  const thief = await generateKeyPairSigner();

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
  console.log("policy:", policyAccount, "\n");

  // --- the agent tries to raise its own ceiling ---------------------------
  const raised = await attempt(() =>
    sendInstructions(client, owner, [
      buildUpdateLimitsV2Instruction({
        policyAccount,
        owner: agent,
        maxPerTransfer: 1_000_000_000_000n,
        maxPerPeriod: 1_000_000_000_000n,
      }),
    ]),
  );
  const afterRaise = await fetchPolicyV2Account(client, policyAccount);
  record(
    "agent tries to give itself a bigger budget",
    `error ${expectationFor("raise-own-limit")}, limit unchanged`,
    `${raised}, limit = ${afterRaise?.maxPerTransfer}`,
    raised === expectationFor("raise-own-limit") && afterRaise?.maxPerTransfer === MAX_PER_TRANSFER,
  );

  // --- a leaked/forged agent key -----------------------------------------
  const stolen = await attempt(() =>
    sendInstructions(client, owner, [
      buildAuthorizeSpendV2Instruction({ policyAccount, agent: thief, amount: 1_000_000n }),
    ]),
  );
  record(
    "an attacker signs with a different key",
    `error ${expectationFor("stolen-key")}`,
    String(stolen),
    stolen === expectationFor("stolen-key"),
  );

  // --- straight over the ceiling -----------------------------------------
  const over = await attempt(() =>
    sendInstructions(client, owner, [
      buildAuthorizeSpendV2Instruction({
        policyAccount,
        agent,
        amount: MAX_PER_TRANSFER + 1n,
      }),
    ]),
  );
  record(
    "agent pays more than the per-transfer cap",
    `error ${expectationFor("over-limit")}`,
    String(over),
    over === expectationFor("over-limit"),
  );

  // --- split the spend to slip past the period budget ---------------------
  // Each payment is individually legal. Only the accumulation stops it.
  let drainCode: number | "succeeded" = "succeeded";
  for (let attemptIndex = 0; attemptIndex < 12; attemptIndex++) {
    drainCode = await attempt(() =>
      sendInstructions(client, owner, [
        buildAuthorizeSpendV2Instruction({ policyAccount, agent, amount: MAX_PER_TRANSFER }),
      ]),
    );
    if (drainCode !== "succeeded") break;
  }
  const afterDrain = await fetchPolicyV2Account(client, policyAccount);
  record(
    "agent splits the spend to get around the period budget",
    `error ${expectationFor("drain-period")}, total never above ${MAX_PER_PERIOD}`,
    `${drainCode}, total = ${afterDrain?.spentInPeriod}`,
    drainCode === expectationFor("drain-period")
      && (afterDrain?.spentInPeriod ?? 0n) <= MAX_PER_PERIOD,
  );

  const breached = results.filter((result) => !result.ok);
  console.log(`\n${results.length - breached.length}/${results.length} attacks blocked.`);
  if (breached.length > 0) {
    throw new Error(`${breached.length} attack(s) got through: ${breached.map((b) => b.step).join("; ")}`);
  }
  console.log("\nALL ATTACKS BLOCKED by the deployed program, on live devnet.");
}

await main();
