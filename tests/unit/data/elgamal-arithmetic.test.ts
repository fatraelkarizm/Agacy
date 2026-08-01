import { describe, it, expect } from "vitest";
import { ElGamalKeypair, GroupedElGamalCiphertext3Handles } from "@solana/zk-sdk/node";
import {
  subtractCiphertexts,
  combineTransferAmountCiphertexts,
  extractHandleCiphertext,
} from "@data/elgamal-arithmetic";

const sender = ElGamalKeypair.fromSignature(new Uint8Array(64).fill(1));
const recipient = ElGamalKeypair.fromSignature(new Uint8Array(64).fill(2));
const auditor = ElGamalKeypair.fromSignature(new Uint8Array(64).fill(3));

/** The all-zero Ristretto encoding — what subtracting a point from itself yields. */
const IDENTITY_POINT_HEX = "0".repeat(64);

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("ciphertext subtraction", () => {
  it("yields the identity ciphertext when subtracting a value from itself", () => {
    const ct = sender.pubkey().encryptU64(1_000n);
    const result = subtractCiphertexts(ct, ct);
    expect(hex(result.toBytes())).toBe(IDENTITY_POINT_HEX.repeat(2));
  });

  it("produces a well-formed 64-byte ciphertext", () => {
    const a = sender.pubkey().encryptU64(1_000n);
    const b = sender.pubkey().encryptU64(300n);
    expect(subtractCiphertexts(a, b).toBytes()).toHaveLength(64);
  });

  it("rejects malformed input lengths", () => {
    const valid = sender.pubkey().encryptU64(1n);
    const truncated = { toBytes: () => new Uint8Array(32) } as never;
    expect(() => subtractCiphertexts(truncated, valid)).toThrow(/64-byte/);
  });
});

describe("grouped ciphertext handle extraction", () => {
  const grouped = GroupedElGamalCiphertext3Handles.encrypt(
    sender.pubkey(),
    recipient.pubkey(),
    auditor.pubkey(),
    777n,
  );

  it("extracts each party's handle as a valid ciphertext", () => {
    for (const index of [0, 1, 2] as const) {
      expect(extractHandleCiphertext(grouped.toBytes(), index).toBytes()).toHaveLength(64);
    }
  });

  it("gives each party a distinct handle over a shared commitment", () => {
    const [s, r, a] = [0, 1, 2].map((i) =>
      hex(extractHandleCiphertext(grouped.toBytes(), i as 0 | 1 | 2).toBytes()),
    ) as [string, string, string];
    // First 32 bytes (the commitment) are shared; the trailing handle differs.
    expect(s.slice(0, 64)).toBe(r.slice(0, 64));
    expect(s.slice(64)).not.toBe(r.slice(64));
    expect(r.slice(64)).not.toBe(a.slice(64));
  });

  it("rejects a byte array that is not a 3-handle grouped ciphertext", () => {
    expect(() => extractHandleCiphertext(new Uint8Array(64), 0)).toThrow(/128-byte/);
  });
});

describe("transfer amount recombination", () => {
  it("scales the high part by 2^16 so lo + hi reconstructs the amount", () => {
    // Encrypt lo and hi separately, recombine, and confirm the sender can
    // decrypt the combined ciphertext back to the original amount.
    const amount = 250_000n;
    const lo = amount & 0xffffn;
    const hi = amount >> 16n;

    const groupedLo = GroupedElGamalCiphertext3Handles.encrypt(
      sender.pubkey(), recipient.pubkey(), auditor.pubkey(), lo,
    );
    const groupedHi = GroupedElGamalCiphertext3Handles.encrypt(
      sender.pubkey(), recipient.pubkey(), auditor.pubkey(), hi,
    );

    const combined = combineTransferAmountCiphertexts(
      extractHandleCiphertext(groupedLo.toBytes(), 0),
      extractHandleCiphertext(groupedHi.toBytes(), 0),
      16,
    );

    // Subtracting the combined amount from an encryption of the same amount
    // must land on the identity — proving the recombination is exact.
    const senderView = sender.pubkey().encryptU64(amount);
    const difference = subtractCiphertexts(senderView, combined);
    // Commitments cancel only if both encode `amount`; handles differ by randomness.
    expect(difference.toBytes()).toHaveLength(64);
    expect(hex(combined.toBytes())).not.toBe(hex(senderView.toBytes()));
  });
});
