import "../tests/setup-env.js";
import { createHash } from "node:crypto";
import { address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS, getCreateAccountInstruction } from "@solana-program/system";
import { createDevnetClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { sendInstructions } from "../server/data/confidential-mint.js";

/**
 * Exercises the deployed `agacy_policy_v2` Anchor program directly on
 * devnet — not litesvm — by calling its real `initialize`, `authorize`, and
 * `authorize_and_invoke` instructions and reading the results back.
 *
 * FEATURES.md #7d notes litesvm already tests this compiled bytecode
 * exhaustively and calls a live devnet call "nice-to-have, not a correctness
 * gap." This closes that gap anyway: `solana program show` only proves the
 * program is executable, not that its instructions behave correctly against
 * a real cluster (real Clock sysvar, real rent, real signature verification).
 *
 * Phase 2 goes further than that: it proves the actual delegate-binding
 * mechanism (not just the policy bookkeeping) on real devnet — the policy
 * PDA CPIs a real classic SPL Token transfer as the token account's real
 * delegate, using the same hand-rolled SPL Token instruction encoding the
 * litesvm test (`tests/delegate_cpi.rs`) uses, for the same reason: every
 * available `spl-token` crate version depends on a Solana SDK generation
 * anchor-lang 1.1.2 doesn't share.
 *
 * Run with: npx tsx scripts/verify-delegate-binding-devnet.ts
 */

const PROGRAM_ID = address("783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G");
const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RENT_SYSVAR_ID = address("SysvarRent111111111111111111111111111111111");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const AccountRole = { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 } as const;

const MAX_PER_TRANSFER = 10_000_000n;
const MAX_PER_PERIOD = 50_000_000n;
const PERIOD_SECONDS = 3_600n;
const WITHIN_LIMIT_AMOUNT = 4_000_000n;
const OVER_LIMIT_AMOUNT = 20_000_000n;

const MINT_LEN = 82n;
const TOKEN_ACCOUNT_LEN = 165n;
const MINT_SUPPLY = 200_000_000n;
// Deliberately larger than the policy limits below, same as the litesvm
// test: proves the *policy* is the binding constraint, not just whatever
// the raw SPL delegate approval happens to allow.
const SPL_DELEGATE_APPROVAL = 100_000_000n;
const CPI_MAX_PER_TRANSFER = 8_000_000n;
const CPI_MAX_PER_PERIOD = 30_000_000n;
const CPI_TRANSFER_AMOUNT = 5_000_000n;

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

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
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

/** Classic SPL Token instruction encoding — see delegate_cpi.rs for why this is hand-rolled. */
function splInitializeMintIx(mint: ReturnType<typeof address>, mintAuthority: ReturnType<typeof address>, decimals: number) {
  const addressEncoder = getAddressEncoder();
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: RENT_SYSVAR_ID, role: AccountRole.READONLY },
    ],
    data: concatBytes([
      Uint8Array.of(0, decimals),
      addressEncoder.encode(mintAuthority),
      Uint8Array.of(0), // freeze_authority: COption::None
    ]),
  };
}

function splInitializeAccountIx(
  tokenAccount: ReturnType<typeof address>,
  mint: ReturnType<typeof address>,
  owner: ReturnType<typeof address>,
) {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: tokenAccount, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: owner, role: AccountRole.READONLY },
      { address: RENT_SYSVAR_ID, role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(1),
  };
}

function splMintToIx(
  mint: ReturnType<typeof address>,
  tokenAccount: ReturnType<typeof address>,
  authority: { address: ReturnType<typeof address> },
  amount: bigint,
) {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: tokenAccount, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
    ],
    data: concatBytes([Uint8Array.of(7), u64le(amount)]),
  };
}

function splApproveIx(
  source: ReturnType<typeof address>,
  delegate: ReturnType<typeof address>,
  owner: { address: ReturnType<typeof address> },
  amount: bigint,
) {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: delegate, role: AccountRole.READONLY },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ],
    data: concatBytes([Uint8Array.of(4), u64le(amount)]),
  };
}

function splTransferData(amount: bigint): Uint8Array {
  return concatBytes([Uint8Array.of(3), u64le(amount)]);
}

/** offset 64: amount(8), per the standard packed SPL Token Account layout. */
function tokenAccountBalance(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

async function fetchTokenBalance(
  client: ReturnType<typeof createDevnetClient>,
  tokenAccount: ReturnType<typeof address>,
): Promise<bigint> {
  const { value } = await client.rpc
    .getAccountInfo(tokenAccount, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!value) throw new Error("Token account not found on devnet");
  const raw = value.data[0]!;
  return tokenAccountBalance(Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)));
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

  console.log("=== Phase 2: authorize_and_invoke — the policy PDA as a real SPL Token delegate ===\n");
  await verifyDelegateCpi(client, owner, addressEncoder);

  console.log("\nALL CHECKS PASSED against the live devnet program (783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G).");
  console.log(`policy account: https://explorer.solana.com/address/${policyPda}?cluster=devnet`);
}

async function verifyDelegateCpi(
  client: ReturnType<typeof createDevnetClient>,
  owner: Awaited<ReturnType<typeof loadOrCreatePayer>>,
  addressEncoder: ReturnType<typeof getAddressEncoder>,
): Promise<void> {
  const agent = await generateKeyPairSigner();
  const [policyPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode("policy"),
      addressEncoder.encode(owner.address),
      addressEncoder.encode(agent.address),
    ],
  });
  console.log("agent (fresh):", agent.address);
  console.log("policy PDA (fresh):", policyPda);

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
      u64le(CPI_MAX_PER_TRANSFER),
      u64le(CPI_MAX_PER_PERIOD),
      i64le(PERIOD_SECONDS),
    ]),
  };
  await sendInstructions(client, owner, [initializeIx]);
  console.log("policy initialized for the CPI test.");

  const mint = await generateKeyPairSigner();
  const source = await generateKeyPairSigner();
  const destination = await generateKeyPairSigner();

  const mintRent = await client.rpc.getMinimumBalanceForRentExemption(MINT_LEN).send();
  await sendInstructions(client, owner, [
    getCreateAccountInstruction({
      payer: owner,
      newAccount: mint,
      lamports: mintRent,
      space: MINT_LEN,
      programAddress: TOKEN_PROGRAM_ID,
    }),
    splInitializeMintIx(mint.address, owner.address, 6),
  ]);
  console.log("mint created:", mint.address);

  const accountRent = await client.rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN).send();
  await sendInstructions(client, owner, [
    getCreateAccountInstruction({
      payer: owner,
      newAccount: source,
      lamports: accountRent,
      space: TOKEN_ACCOUNT_LEN,
      programAddress: TOKEN_PROGRAM_ID,
    }),
    splInitializeAccountIx(source.address, mint.address, owner.address),
  ]);
  await sendInstructions(client, owner, [
    getCreateAccountInstruction({
      payer: owner,
      newAccount: destination,
      lamports: accountRent,
      space: TOKEN_ACCOUNT_LEN,
      programAddress: TOKEN_PROGRAM_ID,
    }),
    splInitializeAccountIx(destination.address, mint.address, owner.address),
  ]);
  console.log("source and destination token accounts created:", source.address, destination.address);

  await sendInstructions(client, owner, [splMintToIx(mint.address, source.address, owner, MINT_SUPPLY)]);
  console.log(`minted ${MINT_SUPPLY} to source.`);

  await sendInstructions(client, owner, [splApproveIx(source.address, policyPda, owner, SPL_DELEGATE_APPROVAL)]);
  console.log(
    `owner approved the policy PDA as delegate for ${SPL_DELEGATE_APPROVAL} — deliberately larger than the policy's own limits, so the policy program itself must be what stops an over-limit transfer.\n`,
  );

  const authorizeAndInvokeIx = (amount: bigint) => ({
    programAddress: PROGRAM_ID,
    accounts: [
      { address: policyPda, role: AccountRole.WRITABLE },
      { address: agent.address, role: AccountRole.READONLY_SIGNER, signer: agent },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: source.address, role: AccountRole.WRITABLE },
      { address: destination.address, role: AccountRole.WRITABLE },
      { address: policyPda, role: AccountRole.READONLY },
    ],
    data: concatBytes([
      anchorDiscriminator("global", "authorize_and_invoke"),
      u64le(amount),
      u32le(9),
      splTransferData(amount),
    ]),
  });

  const destBefore = await fetchTokenBalance(client, destination.address);

  console.log(`sending authorize_and_invoke(${CPI_TRANSFER_AMOUNT}) — within policy, forwarded as a real SPL transfer...`);
  const cpiSig = await sendInstructions(client, owner, [authorizeAndInvokeIx(CPI_TRANSFER_AMOUNT)]);
  console.log("authorize_and_invoke confirmed:", cpiSig);

  const destAfter = await fetchTokenBalance(client, destination.address);
  assertEqual(destAfter - destBefore, CPI_TRANSFER_AMOUNT, "destination balance delta after in-policy CPI transfer");
  console.log(
    "CPI transfer verified: the policy PDA signed for itself as delegate and moved real tokens — the structural bypass is closed on real devnet, not just litesvm.\n",
  );

  console.log(`sending authorize_and_invoke(${CPI_MAX_PER_TRANSFER + 1n}) — exceeds max_per_transfer, expecting rejection...`);
  let rejected = false;
  try {
    await sendInstructions(client, owner, [authorizeAndInvokeIx(CPI_MAX_PER_TRANSFER + 1n)]);
  } catch (error) {
    rejected = true;
    const message = String((error as Error)?.message ?? error);
    console.log("rejected as expected. Error surface:", message.slice(0, 300));
  }
  if (!rejected) {
    throw new Error(
      "An over-limit CPI transfer was NOT rejected on live devnet, even though the raw SPL delegate approval would have allowed it — this is a real bug, not a test artifact.",
    );
  }

  const destFinal = await fetchTokenBalance(client, destination.address);
  assertEqual(destFinal, destAfter, "destination balance (unchanged after rejected over-limit CPI transfer)");
  console.log(
    "over-limit CPI rejection verified: no tokens moved, even though the SPL delegate approval alone would have permitted it — the policy is the real constraint.",
  );
}

await main();
