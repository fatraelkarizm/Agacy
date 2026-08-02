import { describe, it, expect } from "vitest";
import { address, getBase58Decoder } from "@solana/kit";
import { base64ToBytes, createWalletTransactionSigner } from "@data/wallet-signer";

/**
 * What's genuinely testable here without a browser: the byte-level
 * conversion, and that the signer factory produces the shape
 * `TransactionSendingSigner` requires. The actual wallet round-trip
 * (`signAndSendTransactions` calling into a real Phantom/Solflare extension)
 * cannot be exercised in this environment — see the module-level comment in
 * wallet-signer.ts and docs/INFRASTRUCTURE.md before trusting it live.
 */

describe("base64ToBytes", () => {
  it("round-trips arbitrary bytes through base64", () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255, 42, 128]);
    const base64 = btoa(String.fromCharCode(...original));
    expect(base64ToBytes(base64)).toEqual(original);
  });

  it("decodes an empty string to an empty array", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
  });
});

describe("createWalletTransactionSigner", () => {
  const OWNER = address("5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5");

  it("carries the owner's address", () => {
    const signer = createWalletTransactionSigner(OWNER, "phantom");
    expect(signer.address).toBe(OWNER);
  });

  it("exposes signAndSendTransactions, matching the TransactionSendingSigner shape", () => {
    const signer = createWalletTransactionSigner(OWNER, "solflare");
    expect(typeof signer.signAndSendTransactions).toBe("function");
  });
});

// Kept separate from the describe blocks above: this test doubles as
// documentation that `getBase58Decoder`/`Encoder` round-trips the exact
// signature format Phantom/Solflare return, independent of the wallet bridge.
describe("base58 signature round-trip (sanity check for the wallet bridge)", () => {
  it("decodes a base58 signature back to the same bytes it was encoded from", async () => {
    const { getBase58Encoder } = await import("@solana/kit");
    const original = new Uint8Array(64).fill(7);
    const base58 = getBase58Decoder().decode(original);
    expect(getBase58Encoder().encode(base58)).toEqual(original);
  });
});
