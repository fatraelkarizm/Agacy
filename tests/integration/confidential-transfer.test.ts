import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { createDevnetClient, getLamportBalance } from "@data/solana-client";
import { loadOrCreatePayer } from "@data/solana-payer";
import { createConfidentialMint } from "@data/confidential-mint";
import { createConfidentialTokenAccount } from "@data/confidential-account";
import { deriveConfidentialKeys, type ConfidentialKeys } from "@data/confidential-keys";
import {
  applyPendingBalance,
  depositToConfidentialBalance,
  executeConfidentialTransfer,
} from "@data/confidential-transfer";
import { fetchConfidentialBalance } from "@data/confidential-balance";

/**
 * End-to-end confidential transfer against real Solana devnet.
 *
 * This is the product's core claim under test: an amount moves on-chain, the
 * ledger records a real transaction, and yet the amount is not readable from
 * the account data by anyone without the right key.
 *
 * Run with `npm run test:integration`.
 */

const client = createDevnetClient();
const MIN_BALANCE = 200_000_000n;
const DECIMALS = 6;
const DEPOSIT_AMOUNT = 10_000_000n; // 10 tokens
const TRANSFER_AMOUNT = 2_500_000n; // 2.5 tokens

function keysFor(seed: number): ConfidentialKeys {
  return deriveConfidentialKeys(new Uint8Array(64).fill(seed));
}

describe("confidential transfer end-to-end on devnet", () => {
  let payer: KeyPairSigner;
  let recipientOwner: KeyPairSigner;
  let mint: Address;
  let senderAccount: Address;
  let recipientAccount: Address;

  const senderKeys = keysFor(11);
  const recipientKeys = keysFor(22);

  beforeAll(async () => {
    payer = await loadOrCreatePayer();
    const balance = await getLamportBalance(client, payer.address);
    if (balance < MIN_BALANCE) {
      throw new Error(
        `Payer ${payer.address} has ${balance} lamports; needs ${MIN_BALANCE}. ` +
          `Fund it at https://faucet.solana.com (devnet).`,
      );
    }

    recipientOwner = await generateKeyPairSigner();

    ({ mint } = await createConfidentialMint(client, payer, {
      decimals: DECIMALS,
      authority: payer.address,
      autoApproveNewAccounts: true,
    }));

    ({ tokenAccount: senderAccount } = await createConfidentialTokenAccount(
      client,
      payer,
      payer,
      mint,
      senderKeys,
    ));

    ({ tokenAccount: recipientAccount } = await createConfidentialTokenAccount(
      client,
      payer,
      recipientOwner,
      mint,
      recipientKeys,
    ));
  });

  it("configures both accounts for confidential transfers", () => {
    expect(senderAccount).toBeTruthy();
    expect(recipientAccount).toBeTruthy();
    expect(senderAccount).not.toBe(recipientAccount);
  });

  it("deposits into the pending confidential balance and applies it", async () => {
    const depositSig = await depositToConfidentialBalance(client, payer, payer, {
      tokenAccount: senderAccount,
      mint,
      owner: payer,
      amount: DEPOSIT_AMOUNT,
      decimals: DECIMALS,
    });
    expect(depositSig).toBeTruthy();

    const applySig = await applyPendingBalance(client, payer, {
      tokenAccount: senderAccount,
      owner: payer,
      keys: senderKeys,
      newAvailableBalance: DEPOSIT_AMOUNT,
      expectedPendingCreditCounter: 1n,
    });
    expect(applySig).toBeTruthy();
  });

  it("transfers confidentially and hides the amount on-chain", async () => {
    // Proofs must be built over the ciphertext the program actually stores —
    // a fresh local encryption of the same number would be a different
    // ciphertext and the on-chain check would reject it.
    const state = await fetchConfidentialBalance(client, senderAccount, senderKeys);
    expect(state.availableBalance).toBe(DEPOSIT_AMOUNT);

    const { signature, remainingBalance } = await executeConfidentialTransfer(client, payer, {
      sourceToken: senderAccount,
      destinationToken: recipientAccount,
      mint,
      owner: payer,
      senderKeys,
      recipientElGamalPubkey: recipientKeys.elGamal.pubkey(),
      availableBalance: state.availableBalance,
      availableBalanceCiphertext: state.availableBalanceCiphertext,
      amount: TRANSFER_AMOUNT,
    });

    expect(signature).toBeTruthy();
    expect(remainingBalance).toBe(DEPOSIT_AMOUNT - TRANSFER_AMOUNT);

    // The transaction is real and publicly visible...
    const tx = await client.rpc
      .getTransaction(signature as never, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      })
      .send();
    expect(tx).not.toBeNull();

    // ...but the amount is nowhere in the recipient's raw account data.
    const account = await client.rpc
      .getAccountInfo(recipientAccount, { commitment: "confirmed", encoding: "base64" })
      .send();
    const [encoded] = account.value!.data;
    const raw = Buffer.from(encoded, "base64");

    // A public SPL transfer would store the amount as a plain little-endian u64.
    const plaintextAmount = Buffer.alloc(8);
    plaintextAmount.writeBigUInt64LE(TRANSFER_AMOUNT);
    expect(raw.includes(plaintextAmount)).toBe(false);
  });
});
