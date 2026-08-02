import { describe, it, expect, vi } from "vitest";
import { createAgacyPlugin } from "@agent/agacy-plugin";
import { defaultPolicy } from "../../fixtures/transactions";

function makePlugin(overrides: Partial<Parameters<typeof createAgacyPlugin>[0]> = {}) {
  const transfer = vi.fn().mockResolvedValue("5xSignature");
  const plugin = createAgacyPlugin({
    policy: defaultPolicy,
    getState: async () => ({ availableBalance: 100_000_000n, spentThisPeriod: 0n }),
    transfer,
    ...overrides,
  });
  const action = plugin.actions[0]!;
  return { plugin, action, transfer };
}

const agent = {} as never;

describe("Agacy Solana Agent Kit plugin", () => {
  it("registers a confidential transfer action", () => {
    const { plugin, action } = makePlugin();
    expect(plugin.name).toBe("agacy");
    expect(action.name).toBe("AGACY_CONFIDENTIAL_TRANSFER");
    expect(action.schema).toBeDefined();
  });

  it("executes a policy-compliant transfer and reports the signature", async () => {
    const { action, transfer } = makePlugin();
    const result = await action.handler(agent, { amount: 4.2, recipient: "RecipientA" });

    expect(result).toMatchObject({ status: "success", signature: "5xSignature", confidential: true });
    expect(transfer).toHaveBeenCalledWith(4_200_000n, "RecipientA");
  });

  it("converts whole tokens to base units using the given decimals", async () => {
    const { action, transfer } = makePlugin();
    await action.handler(agent, { amount: 0.0015, recipient: "RecipientA", decimals: 9 });
    expect(transfer).toHaveBeenCalledWith(1_500_000n, "RecipientA");
  });

  it("refuses an over-limit transfer without touching the chain", async () => {
    const { action, transfer } = makePlugin();
    const result = await action.handler(agent, { amount: 999, recipient: "RecipientA" });

    expect(result).toMatchObject({ status: "refused" });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("returns the refusal as a result the agent can reason about, not an exception", async () => {
    const { action } = makePlugin();
    const result = (await action.handler(agent, { amount: 999, recipient: "RecipientA" })) as {
      reason: string;
    };
    expect(result.reason).toMatch(/per-transfer limit/);
  });

  it("refuses a recipient outside the allow-list", async () => {
    const { action, transfer } = makePlugin({
      policy: { ...defaultPolicy, allowedRecipients: ["TrustedOnly"] },
    });
    const result = await action.handler(agent, { amount: 1, recipient: "AttackerWallet" });

    expect(result).toMatchObject({ status: "refused" });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("rejects a malformed request before any policy or chain work", async () => {
    const { action, transfer } = makePlugin();
    await expect(action.handler(agent, { amount: -5, recipient: "RecipientA" })).rejects.toThrow();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("reads live state per call rather than caching a stale budget", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ availableBalance: 100_000_000n, spentThisPeriod: 0n })
      .mockResolvedValueOnce({ availableBalance: 100_000_000n, spentThisPeriod: 50_000_000n });
    const { action } = makePlugin({ getState });

    expect(await action.handler(agent, { amount: 1, recipient: "R" })).toMatchObject({
      status: "success",
    });
    expect(await action.handler(agent, { amount: 1, recipient: "R" })).toMatchObject({
      status: "refused",
    });
  });
});
