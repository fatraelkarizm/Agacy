import { describe, it, expect } from "vitest";
import { ElGamalKeypair } from "@solana/zk-sdk/node";
import {
  splitTransferAmount,
  joinTransferAmount,
  generateTransferProofs,
  MAX_TRANSFER_AMOUNT,
  RECIPIENT_HANDLE_INDEX,
} from "@data/confidential-proofs";

function signature(fill: number): Uint8Array {
  return new Uint8Array(64).fill(fill);
}

describe("transfer amount splitting", () => {
  it("round-trips arbitrary amounts", () => {
    for (const amount of [0n, 1n, 65_535n, 65_536n, 1_000_000n, MAX_TRANSFER_AMOUNT]) {
      expect(joinTransferAmount(splitTransferAmount(amount))).toBe(amount);
    }
  });

  it("keeps lo within 16 bits and hi within 32 bits", () => {
    const { lo, hi } = splitTransferAmount(MAX_TRANSFER_AMOUNT);
    expect(lo).toBeLessThan(1n << 16n);
    expect(hi).toBeLessThan(1n << 32n);
  });

  it("rejects amounts above the protocol maximum", () => {
    expect(() => splitTransferAmount(MAX_TRANSFER_AMOUNT + 1n)).toThrow(/exceeds/);
  });

  it("rejects negative amounts", () => {
    expect(() => splitTransferAmount(-1n)).toThrow(/negative/);
  });
});

describe("confidential transfer proof generation", () => {
  const sender = ElGamalKeypair.fromSignature(signature(1));
  const recipient = ElGamalKeypair.fromSignature(signature(2));
  const auditor = ElGamalKeypair.fromSignature(signature(3));

  function proofsFor(availableBalance: bigint, amount: bigint) {
    return generateTransferProofs({
      senderKeypair: sender,
      recipientPubkey: recipient.pubkey(),
      auditorPubkey: auditor.pubkey(),
      availableBalance,
      amount,
      availableBalanceCiphertext: sender.pubkey().encryptU64(availableBalance),
    });
  }

  it("produces three verifying proofs for a valid transfer", () => {
    const proofs = proofsFor(1_000_000n, 250_000n);
    // verify() throws on an invalid proof, so reaching the end means all three hold.
    expect(() => proofs.equality.verify()).not.toThrow();
    expect(() => proofs.ciphertextValidity.verify()).not.toThrow();
    expect(() => proofs.range.verify()).not.toThrow();
  });

  it("computes the remaining balance correctly", () => {
    expect(proofsFor(1_000_000n, 250_000n).remainingBalance).toBe(750_000n);
  });

  it("encrypts the transfer amount so the recipient can decrypt it", () => {
    const amount = 250_000n;
    const proofs = proofsFor(1_000_000n, amount);
    // Index 1 is the recipient's handle in the 3-handle grouped ciphertext.
    const lo = proofs.groupedLo.decrypt(recipient.secret(), RECIPIENT_HANDLE_INDEX);
    const hi = proofs.groupedHi.decrypt(recipient.secret(), RECIPIENT_HANDLE_INDEX);
    expect(lo + (hi << 16n)).toBe(amount);
  });

  it("hides the amount from an unrelated third party", () => {
    const stranger = ElGamalKeypair.fromSignature(signature(9));
    const proofs = proofsFor(1_000_000n, 250_000n);
    // Decryption with an unauthorized key fails outright rather than returning
    // a wrong number — the amount is unrecoverable, not merely obscured.
    expect(() => proofs.groupedLo.decrypt(stranger.secret(), RECIPIENT_HANDLE_INDEX)).toThrow();
  });

  it("refuses to transfer more than the available balance", () => {
    expect(() => proofsFor(100n, 101n)).toThrow(/Insufficient/);
  });

  it("handles a full-balance transfer leaving zero", () => {
    const proofs = proofsFor(500_000n, 500_000n);
    expect(proofs.remainingBalance).toBe(0n);
    expect(() => proofs.range.verify()).not.toThrow();
  });
});
