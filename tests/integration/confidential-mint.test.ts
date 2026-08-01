import { describe, it, expect, beforeAll } from "vitest";
import { type KeyPairSigner } from "@solana/kit";
import {
  createDevnetClient,
  fundFromFaucet,
  getLamportBalance,
  loadOrCreatePayer,
} from "@data/solana-client";
import { createConfidentialMint } from "@data/confidential-mint";

/**
 * Hits real Solana devnet. Run with `npm run test:integration`.
 * The devnet faucet is rate-limited, so a failure here is often infrastructure
 * rather than a code regression — the assertions distinguish the two where possible.
 */

const client = createDevnetClient();
const ONE_SOL = 1_000_000_000n;

describe("confidential mint on devnet", () => {
  let payer: KeyPairSigner;

  beforeAll(async () => {
    payer = await loadOrCreatePayer();
    await fundFromFaucet(client, payer.address, ONE_SOL);
    const balance = await getLamportBalance(client, payer.address);
    if (balance === 0n) {
      throw new Error("Faucet funding did not land; devnet faucet may be rate-limited.");
    }
  });

  it("creates a mint with the confidential transfer extension enabled", async () => {
    const { mint, signature } = await createConfidentialMint(client, payer, {
      decimals: 6,
      authority: payer.address,
      autoApproveNewAccounts: true,
    });

    expect(mint).toBeTruthy();
    expect(signature).toBeTruthy();

    const account = await client.rpc
      .getAccountInfo(mint, { commitment: "confirmed", encoding: "base64" })
      .send();

    expect(account.value).not.toBeNull();
    // A bare mint is 82 bytes; the confidential transfer extension makes it larger.
    const [data] = account.value!.data;
    expect(Buffer.from(data, "base64").length).toBeGreaterThan(82);
  });
});
