import "../tests/setup-env.js";
import { writeFileSync } from "node:fs";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { createDevnetClient, type SolanaClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { createConfidentialMint, sendInstructions } from "../server/data/confidential-mint.js";
import { createConfidentialTokenAccount } from "../server/data/confidential-account.js";
import { deriveConfidentialKeys } from "../server/data/confidential-keys.js";
import {
  applyPendingBalance,
  depositToConfidentialBalance,
  executeConfidentialTransfer,
} from "../server/data/confidential-transfer.js";
import { fetchConfidentialBalance } from "../server/data/confidential-balance.js";

/**
 * What confidentiality actually costs, measured on devnet.
 *
 * The submission could describe the privacy guarantee but never answered the
 * first question an operator asks: can I afford to run this? A confidential
 * transfer needs three ZK proofs verified into context accounts before the
 * transfer instruction can run, so it is structurally more than one
 * transaction — but "more" is not a number, and nobody adopts a number they
 * have not been shown.
 *
 * Both paths below move the same amount of the same token on the same cluster.
 * The only difference is whether the amount is encrypted. Setup and per-payment
 * costs are reported separately because they amortise differently: setup is
 * paid once per agent, the per-payment cost is paid forever.
 *
 * Run with: npx tsx scripts/measure-cost-devnet.ts
 */

const DECIMALS = 6;
const MINT_AMOUNT = 10_000_000n;
const TRANSFER = 2_500_000n;
/** Signature indexing lags the confirmation, so counting too early undercounts. */
const INDEX_SETTLE_MS = 2_500;

const client = createDevnetClient();
const payer = await loadOrCreatePayer();

console.log("payer:", payer.address);

interface Measurement {
  readonly label: string;
  readonly lamports: number;
  readonly transactions: number;
  readonly milliseconds: number;
}

async function balance(): Promise<bigint> {
  const { value } = await client.rpc.getBalance(payer.address, { commitment: "confirmed" }).send();
  return BigInt(value);
}

/**
 * Counted by slot rather than with `until`. The obvious approach — take the
 * newest signature as a marker and pass it as `until` — fails against a
 * provider that has confirmed the transaction but not yet indexed it for
 * history lookups: the RPC answers "Transaction not found" and the whole run
 * dies over bookkeeping. Comparing slots needs no such lookup.
 */
async function currentSlot(): Promise<bigint> {
  return BigInt(await client.rpc.getSlot({ commitment: "confirmed" }).send());
}

async function transactionsSinceSlot(slot: bigint): Promise<number> {
  try {
    const rows = await client.rpc
      .getSignaturesForAddress(payer.address, { commitment: "confirmed", limit: 200 })
      .send();
    return rows.filter((row) => BigInt(row.slot) > slot).length;
  } catch {
    // The cost and latency numbers are the point; a transaction count that
    // could not be read should not discard a run that otherwise succeeded.
    return -1;
  }
}

/**
 * Cost is read from the payer's balance delta rather than by summing
 * transaction fees. The delta is what actually leaves the account, so it also
 * captures rent for the proof context accounts — and the refund when they are
 * closed again. Summing fees alone would report a confidential transfer as
 * cheaper than it is.
 */
async function measure<T>(label: string, run: () => Promise<T>): Promise<[Measurement, T]> {
  const startSlot = await currentSlot();
  const before = await balance();
  const started = Date.now();
  const result = await run();
  const milliseconds = Date.now() - started;
  await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_MS));
  const after = await balance();
  const transactions = await transactionsSinceSlot(startSlot);
  const measurement = {
    label,
    lamports: Number(before - after),
    transactions,
    milliseconds,
  };
  console.log(
    `  ${label}: ${measurement.lamports} lamports · ${transactions} tx · ${milliseconds}ms`,
  );
  return [measurement, result];
}

/* ----------------------------- public baseline ---------------------------- */

async function createPlainMint(): Promise<Address> {
  const mintSigner = await generateKeyPairSigner();
  // No argument, not `[]`: an empty extension list still reserves the
  // extension header (166 bytes) and InitializeMint2 rejects it. A mint with
  // no extensions is the bare 82.
  const space = BigInt(getMintSize());
  // Returns the lamport value directly, not an `{ value }` envelope.
  const rent = await client.rpc.getMinimumBalanceForRentExemption(space).send();

  await sendInstructions(client, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: mintSigner,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mintSigner.address,
      decimals: DECIMALS,
      mintAuthority: payer.address,
      freezeAuthority: null,
    }),
  ]);
  return mintSigner.address;
}

async function createPlainAccount(mint: Address, owner: KeyPairSigner): Promise<Address> {
  const accountSigner = await generateKeyPairSigner();
  const space = 165n;
  const rent = await client.rpc.getMinimumBalanceForRentExemption(space).send();

  await sendInstructions(client, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: accountSigner,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccount3Instruction({
      account: accountSigner.address,
      mint,
      owner: owner.address,
    }),
  ]);
  return accountSigner.address;
}

console.log("\n[public] ordinary SPL transfer — amount visible to anyone");

const [publicSetup, publicAccounts] = await measure("setup", async () => {
  const mint = await createPlainMint();
  const source = await createPlainAccount(mint, payer);
  const recipientOwner = await generateKeyPairSigner();
  const destination = await createPlainAccount(mint, recipientOwner);
  await sendInstructions(client, payer, [
    getMintToInstruction({
      mint,
      token: source,
      mintAuthority: payer,
      amount: MINT_AMOUNT,
    }),
  ]);
  return { mint, source, destination };
});

const [publicTransfer] = await measure("one payment", async () =>
  sendInstructions(client, payer, [
    getTransferCheckedInstruction({
      source: publicAccounts.source,
      mint: publicAccounts.mint,
      destination: publicAccounts.destination,
      authority: payer,
      amount: TRANSFER,
      decimals: DECIMALS,
    }),
  ]),
);

/* --------------------------- confidential path ---------------------------- */

console.log("\n[confidential] Token-2022 confidential transfer — amount encrypted");

const senderKeys = deriveConfidentialKeys(new Uint8Array(64).fill(11));
const recipientKeys = deriveConfidentialKeys(new Uint8Array(64).fill(22));

const [confidentialSetup, confidentialAccounts] = await measure("setup", async () => {
  const { mint } = await createConfidentialMint(client, payer, {
    decimals: DECIMALS,
    authority: payer.address,
    autoApproveNewAccounts: true,
  });
  const recipientOwner = await generateKeyPairSigner();
  const { tokenAccount: source } = await createConfidentialTokenAccount(
    client, payer, payer, mint, senderKeys,
  );
  const { tokenAccount: destination } = await createConfidentialTokenAccount(
    client, payer, recipientOwner, mint, recipientKeys,
  );
  await sendInstructions(client, payer, [
    getMintToInstruction({ mint, token: source, mintAuthority: payer, amount: MINT_AMOUNT }),
  ]);
  await depositToConfidentialBalance(client, payer, payer, {
    tokenAccount: source, mint, owner: payer, amount: MINT_AMOUNT, decimals: DECIMALS,
  });
  await applyPendingBalance(client, payer, {
    tokenAccount: source, owner: payer, keys: senderKeys,
    newAvailableBalance: MINT_AMOUNT, expectedPendingCreditCounter: 1n,
  });
  return { mint, source, destination };
});

const state = await fetchConfidentialBalance(client, confidentialAccounts.source, senderKeys);
const [confidentialTransfer] = await measure("one payment", async () =>
  executeConfidentialTransfer(client, payer, {
    sourceToken: confidentialAccounts.source,
    destinationToken: confidentialAccounts.destination,
    mint: confidentialAccounts.mint,
    owner: payer,
    senderKeys,
    recipientElGamalPubkey: recipientKeys.elGamal.pubkey(),
    availableBalance: state.availableBalance,
    availableBalanceCiphertext: state.availableBalanceCiphertext,
    amount: TRANSFER,
  }),
);

/* --------------------------------- report --------------------------------- */

const LAMPORTS_PER_SOL = 1_000_000_000;
const premium = confidentialTransfer.lamports - publicTransfer.lamports;

const report = {
  capturedAt: new Date().toISOString(),
  cluster: "devnet",
  transferAmount: TRANSFER.toString(),
  decimals: DECIMALS,
  publicPath: { setup: publicSetup, perPayment: publicTransfer },
  confidentialPath: { setup: confidentialSetup, perPayment: confidentialTransfer },
  perPaymentPremiumLamports: premium,
  perPaymentPremiumSol: premium / LAMPORTS_PER_SOL,
  note:
    "Costs are payer balance deltas, so they include proof context account rent and its refund on close. " +
    "Latency is wall clock against a Helius devnet RPC and will vary with the endpoint.",
};

writeFileSync("server/data/cost-proof.json", `${JSON.stringify(report, null, 2)}\n`);

console.log("\n--- per payment ---");
console.log("public:      ", publicTransfer.lamports, "lamports /", publicTransfer.transactions, "tx /", `${publicTransfer.milliseconds}ms`);
console.log("confidential:", confidentialTransfer.lamports, "lamports /", confidentialTransfer.transactions, "tx /", `${confidentialTransfer.milliseconds}ms`);
console.log("premium:     ", premium, `lamports (${(premium / LAMPORTS_PER_SOL).toFixed(9)} SOL)`);
console.log("\nsaved -> server/data/cost-proof.json");
