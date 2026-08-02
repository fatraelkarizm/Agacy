import { describe, expect, it } from "vitest";
import { decryptReasoning, deriveReasoningKey, encryptReasoning } from "@data/reasoning-crypto";

const SIGNATURE_A = new Uint8Array(64).fill(11);
const SIGNATURE_B = new Uint8Array(64).fill(22);

describe("reasoning encryption", () => {
  it("round-trips arbitrary reasoning text under the same derived key", async () => {
    const key = await deriveReasoningKey(SIGNATURE_A);
    const reasoning = "Renewed the API subscription because usage stayed within the monthly budget.";

    const payload = await encryptReasoning(key, reasoning);
    const recovered = await decryptReasoning(key, payload);

    expect(recovered).toBe(reasoning);
  });

  it("never leaves the plaintext readable in the encrypted payload bytes", async () => {
    const key = await deriveReasoningKey(SIGNATURE_A);
    const reasoning = "Paid the supplier invoice for last week's materials shipment.";

    const payload = await encryptReasoning(key, reasoning);
    const asText = Buffer.from(payload).toString("latin1");

    expect(asText).not.toContain("supplier");
    expect(asText).not.toContain(reasoning);
  });

  it("derives the same key from the same signature every time", async () => {
    const keyOne = await deriveReasoningKey(SIGNATURE_A);
    const keyTwo = await deriveReasoningKey(SIGNATURE_A);
    const reasoning = "Deterministic key derivation check.";

    const payload = await encryptReasoning(keyOne, reasoning);
    expect(await decryptReasoning(keyTwo, payload)).toBe(reasoning);
  });

  it("refuses to decrypt with the wrong signature's key", async () => {
    const ownerKey = await deriveReasoningKey(SIGNATURE_A);
    const impostorKey = await deriveReasoningKey(SIGNATURE_B);
    const payload = await encryptReasoning(ownerKey, "Only the owner should read this.");

    await expect(decryptReasoning(impostorKey, payload)).rejects.toThrow();
  });

  it("rejects a signature of the wrong length", async () => {
    await expect(deriveReasoningKey(new Uint8Array(32))).rejects.toThrow(/64-byte/);
  });

  it("produces a different ciphertext each time even for identical reasoning", async () => {
    const key = await deriveReasoningKey(SIGNATURE_A);
    const reasoning = "Same text, different run.";

    const first = await encryptReasoning(key, reasoning);
    const second = await encryptReasoning(key, reasoning);

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });
});
