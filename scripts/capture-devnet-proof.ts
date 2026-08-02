import "../tests/setup-env.js";
import { writeFileSync } from "node:fs";
import { generateKeyPairSigner } from "@solana/kit";
import { createDevnetClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { createConfidentialMint } from "../server/data/confidential-mint.js";
import { createConfidentialTokenAccount } from "../server/data/confidential-account.js";
import { deriveConfidentialKeys } from "../server/data/confidential-keys.js";
import {
  applyPendingBalance,
  depositToConfidentialBalance,
  executeConfidentialTransfer,
} from "../server/data/confidential-transfer.js";
import { fetchConfidentialBalance } from "../server/data/confidential-balance.js";

/**
 * Runs the full confidential transfer flow on devnet and records the real
 * addresses and signatures, so the demo can link to actual on-chain evidence
 * instead of asking anyone to take the claim on trust.
 *
 * Run with: npx tsx scripts/capture-devnet-proof.ts
 */

const DECIMALS = 6;
const DEPOSIT = 10_000_000n;
const TRANSFER = 2_500_000n;

const client = createDevnetClient();
const payer = await loadOrCreatePayer();
const senderKeys = deriveConfidentialKeys(new Uint8Array(64).fill(11));
const recipientKeys = deriveConfidentialKeys(new Uint8Array(64).fill(22));
const recipientOwner = await generateKeyPairSigner();

console.log("payer:", payer.address);

const { mint } = await createConfidentialMint(client, payer, {
  decimals: DECIMALS,
  authority: payer.address,
  autoApproveNewAccounts: true,
});
console.log("mint:", mint);

const { tokenAccount: senderAccount } = await createConfidentialTokenAccount(
  client, payer, payer, mint, senderKeys,
);
const { tokenAccount: recipientAccount } = await createConfidentialTokenAccount(
  client, payer, recipientOwner, mint, recipientKeys,
);
console.log("sender:", senderAccount, "\nrecipient:", recipientAccount);

const depositSignature = await depositToConfidentialBalance(client, payer, payer, {
  tokenAccount: senderAccount, mint, owner: payer, amount: DEPOSIT, decimals: DECIMALS,
});
await applyPendingBalance(client, payer, {
  tokenAccount: senderAccount, owner: payer, keys: senderKeys,
  newAvailableBalance: DEPOSIT, expectedPendingCreditCounter: 1n,
});

const state = await fetchConfidentialBalance(client, senderAccount, senderKeys);
const { signature, remainingBalance } = await executeConfidentialTransfer(client, payer, {
  sourceToken: senderAccount,
  destinationToken: recipientAccount,
  mint,
  owner: payer,
  senderKeys,
  recipientElGamalPubkey: recipientKeys.elGamal.pubkey(),
  availableBalance: state.availableBalance,
  availableBalanceCiphertext: state.availableBalanceCiphertext,
  amount: TRANSFER,
});

// Confirm the claim rather than asserting it: the transferred amount must not
// appear as a plaintext u64 anywhere in the recipient's account data.
const account = await client.rpc
  .getAccountInfo(recipientAccount, { commitment: "confirmed", encoding: "base64" })
  .send();
const raw = Buffer.from(account.value!.data[0], "base64");
const plaintext = Buffer.alloc(8);
plaintext.writeBigUInt64LE(TRANSFER);

const proof = {
  capturedAt: new Date().toISOString(),
  cluster: "devnet",
  mint,
  senderAccount,
  recipientAccount,
  depositSignature,
  transferSignature: signature,
  transferAmount: TRANSFER.toString(),
  remainingBalance: remainingBalance.toString(),
  amountFoundInRecipientAccountData: raw.includes(plaintext),
};

writeFileSync("server/data/devnet-proof.json", JSON.stringify(proof, null, 2) + "\n");
console.log("\ntransfer signature:", signature);
console.log("amount readable in recipient account data:", proof.amountFoundInRecipientAccountData);
console.log("saved -> server/data/devnet-proof.json");
