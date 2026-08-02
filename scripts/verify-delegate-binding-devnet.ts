import "../tests/setup-env.js";
import { createHash } from "node:crypto";
import { address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { createDevnetClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { sendInstructions } from "../server/data/confidential-mint.js";

/**
 * Exercises the deployed `agacy_policy_v2` Anchor program directly on
 * devnet — not litesvm — by calling its real `initialize` and `authorize`
 * instructions and reading the resulting account back.
 *
 * FEATURES.md #7d notes litesvm already tests this compiled bytecode
 * exhaustively and calls a live devnet call "nice-to-have, not a correctness
 * gap." This closes that gap anyway: `solana program show` only proves the
 * program is executable, not that its instructions behave correctly against
 * a real cluster (real Clock sysvar, real rent, real signature verification).
 *
 * Run with: npx tsx scripts/verify-delegate-binding-devnet.ts
 */

const PROGRAM_ID = address("783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const AccountRole = { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 } as const;

const MAX_PER_TRANSFER = 10_000_000n;
const MAX_PER_PERIOD = 50_000_000n;
const PERIOD_SECONDS = 3_600n;
const WITHIN_LIMIT_AMOUNT = 4_000_000n;
const OVER_LIMIT_AMOUNT = 20_000_000n;

function anchorDiscriminator(namespace: "global" | "account", name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8));
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bytesToBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = (num << 8n) | BigInt(byte);
  let out = "";
  while (num > 0n) {
    out = BASE58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

interface PolicyAccount {
  readonly owner: string;
  readonly agent: string;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
  readonly spentInPeriod: bigint;
  readonly periodStart: bigint;
  readonly bump: number;
}

/** disc(8) + owner(32) + agent(32) + 5 numeric fields + bump — matches state.rs. */
function decodePolicy(data: Uint8Array): PolicyAccount {
  const expected = anchorDiscriminator("account", "Policy");
  const actual = data.subarray(0, 8);
  if (!actual.every((byte, index) => byte === expected[index])) {
    throw new Error("Account discriminator does not match Policy — wrong account or program");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    owner: bytesToBase58(data.subarray(8, 40)),
    agent: bytesToBase58(data.subarray(40, 72)),
    maxPerTransfer: view.getBigUint64(72, true),
    maxPerPeriod: view.getBigUint64(80, true),
    periodSeconds: view.getBigInt64(88, true),
    spentInPeriod: view.getBigUint64(96, true),
    periodStart: view.getBigInt64(104, true),
    bump: data[112]!,
  };
}

async function fetchPolicy(
  client: ReturnType<typeof createDevnetClient>,
  policyPda: ReturnType<typeof address>,
): Promise<PolicyAccount> {
  const { value } = await client.rpc
    .getAccountInfo(policyPda, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!value) throw new Error("Policy account not found on devnet");
  const raw = value.data[0]!;
  const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  return decodePolicy(bytes);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`Mismatch for ${label}: expected ${expected}, got ${actual}`);
  }
}

async function main(): Promise<void> {
  const client = createDevnetClient();
  const owner = await loadOrCreatePayer();
  const agent = await generateKeyPairSigner();
  const addressEncoder = getAddressEncoder();

  console.log("owner:", owner.address);
  console.log("agent:", agent.address);

  const [policyPda, bump] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode("policy"),
      addressEncoder.encode(owner.address),
      addressEncoder.encode(agent.address),
    ],
  });
  console.log("policy PDA:", policyPda, "bump:", bump);

  const initializeIx = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: policyPda, role: AccountRole.WRITABLE },
      { address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: owner },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concatBytes([
      anchorDiscriminator("global", "initialize"),
      addressEncoder.encode(agent.address),
      u64le(MAX_PER_TRANSFER),
      u64le(MAX_PER_PERIOD),
      i64le(PERIOD_SECONDS),
    ]),
  };

  console.log("\nsending initialize...");
  const initSig = await sendInstructions(client, owner, [initializeIx]);
  console.log("initialize confirmed:", initSig);

  const afterInit = await fetchPolicy(client, policyPda);
  assertEqual(afterInit.owner, owner.address, "owner");
  assertEqual(afterInit.agent, agent.address, "agent");
  assertEqual(afterInit.maxPerTransfer, MAX_PER_TRANSFER, "maxPerTransfer");
  assertEqual(afterInit.maxPerPeriod, MAX_PER_PERIOD, "maxPerPeriod");
  assertEqual(afterInit.spentInPeriod, 0n, "spentInPeriod (fresh)");
  console.log("initialize verified: on-chain account matches requested limits exactly.\n");

  const authorizeIx = (amount: bigint) => ({
    programAddress: PROGRAM_ID,
    accounts: [
      { address: policyPda, role: AccountRole.WRITABLE },
      { address: agent.address, role: AccountRole.READONLY_SIGNER, signer: agent },
    ],
    data: concatBytes([anchorDiscriminator("global", "authorize"), u64le(amount)]),
  });

  console.log(`sending authorize(${WITHIN_LIMIT_AMOUNT}) — within policy...`);
  const authSig = await sendInstructions(client, owner, [authorizeIx(WITHIN_LIMIT_AMOUNT)]);
  console.log("authorize confirmed:", authSig);

  const afterAuthorize = await fetchPolicy(client, policyPda);
  assertEqual(afterAuthorize.spentInPeriod, WITHIN_LIMIT_AMOUNT, "spentInPeriod (after in-policy spend)");
  console.log("in-policy spend verified: spent_in_period incremented by exactly the authorized amount.\n");

  console.log(`sending authorize(${OVER_LIMIT_AMOUNT}) — exceeds max_per_transfer, expecting rejection...`);
  let rejected = false;
  try {
    await sendInstructions(client, owner, [authorizeIx(OVER_LIMIT_AMOUNT)]);
  } catch (error) {
    rejected = true;
    const message = String((error as Error)?.message ?? error);
    console.log("rejected as expected. Error surface:", message.slice(0, 300));
  }
  if (!rejected) {
    throw new Error(
      "Over-limit authorize was NOT rejected by the live devnet program — this is a real bug, not a test artifact.",
    );
  }

  const afterRejection = await fetchPolicy(client, policyPda);
  assertEqual(afterRejection.spentInPeriod, WITHIN_LIMIT_AMOUNT, "spentInPeriod (unchanged after rejected over-limit spend)");
  console.log("over-limit rejection verified: spent_in_period did not move.\n");

  console.log("ALL CHECKS PASSED against the live devnet program (783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G).");
  console.log(`policy account: https://explorer.solana.com/address/${policyPda}?cluster=devnet`);
}

await main();
