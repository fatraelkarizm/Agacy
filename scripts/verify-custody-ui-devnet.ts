import "../tests/setup-env.js";
import { generateKeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintToInstruction,
  getMintSize,
  getTokenSize,
} from "@solana-program/token-2022";
import { createDevnetClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { sendInstructions } from "../server/data/confidential-mint.js";
import {
  buildAssumeCustodyInstruction,
  buildInitializePolicyV2Instruction,
  buildReleaseCustodyInstruction,
  derivePolicyAddress,
  fetchPolicyV2Account,
} from "../server/data/policy-program-v2.js";

/**
 * The exact instruction sequence the dashboard's custody buttons send.
 *
 * Custody itself was already proven against a confidential account by
 * `npm run verify-custody`. What is new here is the shape the browser uses:
 * a plain Token-2022 account created and funded in a single transaction, then
 * handed over and taken back. Verified headlessly first so no button ships
 * against an untested path.
 *
 * Run with: npm run verify-custody-ui
 */

const DECIMALS = 6;
const DEMO_SUPPLY = 500_000_000n;
const MAX_PER_TRANSFER = 20_000_000n;
const MAX_PER_PERIOD = 50_000_000n;
const PERIOD_SECONDS = 3_600n;

const results: { step: string; expected: string; observed: string; ok: boolean }[] = [];

function record(step: string, expected: string, observed: string, ok: boolean): void {
  results.push({ step, expected, observed, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n      expected: ${expected}\n      observed: ${observed}\n`);
}

async function main(): Promise<void> {
  const client = createDevnetClient();
  const owner = await loadOrCreatePayer();
  const agent = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const tokenAccount = await generateKeyPairSigner();

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

  // --- one transaction: mint, account, and supply -------------------------
  const mintSpace = BigInt(getMintSize());
  const tokenSpace = BigInt(getTokenSize());
  const [mintRent, tokenRent] = await Promise.all([
    client.rpc.getMinimumBalanceForRentExemption(mintSpace).send(),
    client.rpc.getMinimumBalanceForRentExemption(tokenSpace).send(),
  ]);

  await sendInstructions(client, owner, [
    getCreateAccountInstruction({
      payer: owner,
      newAccount: mint,
      lamports: mintRent,
      space: mintSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction(
      { mint: mint.address, decimals: DECIMALS, mintAuthority: owner.address, freezeAuthority: null },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
    getCreateAccountInstruction({
      payer: owner,
      newAccount: tokenAccount,
      lamports: tokenRent,
      space: tokenSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccount3Instruction(
      { account: tokenAccount.address, mint: mint.address, owner: owner.address },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
    getMintToInstruction(
      { mint: mint.address, token: tokenAccount.address, mintAuthority: owner, amount: DEMO_SUPPLY },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
  ]);

  const created = await fetchToken(client.rpc, tokenAccount.address);
  record(
    "one transaction creates the mint, the account, and its balance",
    `owner ${owner.address}, balance ${DEMO_SUPPLY}`,
    `owner ${created.data.owner}, balance ${created.data.amount}`,
    created.data.owner === owner.address && created.data.amount === DEMO_SUPPLY,
  );

  // --- hand it over --------------------------------------------------------
  await sendInstructions(client, owner, [
    buildAssumeCustodyInstruction({
      policyAccount,
      owner,
      tokenAccount: tokenAccount.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ]);
  const custodied = await fetchToken(client.rpc, tokenAccount.address);
  const policyState = await fetchPolicyV2Account(client, policyAccount);
  record(
    "handing over makes the policy program the account's real owner",
    `${policyAccount}, recorded in the policy`,
    `${custodied.data.owner}, recorded: ${policyState?.custodiedTokenAccount}`,
    custodied.data.owner === policyAccount
      && policyState?.custodiedTokenAccount === tokenAccount.address,
  );

  // --- take it back --------------------------------------------------------
  await sendInstructions(client, owner, [
    buildReleaseCustodyInstruction({
      policyAccount,
      owner,
      tokenAccount: tokenAccount.address,
      newAuthority: owner.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ]);
  const released = await fetchToken(client.rpc, tokenAccount.address);
  const clearedPolicy = await fetchPolicyV2Account(client, policyAccount);
  record(
    "taking it back returns ownership and clears the record",
    `${owner.address}, record cleared`,
    `${released.data.owner}, record: ${clearedPolicy?.custodiedTokenAccount ?? "cleared"}`,
    released.data.owner === owner.address && clearedPolicy?.custodiedTokenAccount === null,
  );

  record(
    "the balance is untouched by either transition",
    String(DEMO_SUPPLY),
    String(released.data.amount),
    released.data.amount === DEMO_SUPPLY,
  );

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log(`token account: ${tokenAccount.address}`);
  if (failed.length > 0) {
    throw new Error(`${failed.length} check(s) failed: ${failed.map((f) => f.step).join("; ")}`);
  }
  console.log("\nALL CHECKS PASSED: the dashboard's custody buttons send a path that works.");
}

await main();
