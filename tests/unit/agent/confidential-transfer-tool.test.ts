import { describe, it, expect, vi } from "vitest";
import { createConfidentialTransferTool } from "@agent/tools/confidential-transfer-tool";
import type { AgentDecisionDTO } from "@dto/agent.dto";
import { authorizedTx, defaultPolicy } from "../../fixtures/transactions";

function makeTool(overrides: Partial<Parameters<typeof createConfidentialTransferTool>[0]> = {}) {
  const execute = vi.fn().mockResolvedValue(authorizedTx);
  const tool = createConfidentialTransferTool({
    policy: defaultPolicy,
    getContext: async () => ({ spentThisPeriod: 0n, availableBalance: 100_000_000n }),
    execute,
    ...overrides,
  });
  return { tool, execute };
}

const validTransfer: AgentDecisionDTO = {
  action: "transfer",
  reasoning: "Monthly subscription is due.",
  proposedAmount: 4_200_000n,
  recipient: "RecipientPubkey11111111111111111111111111111",
};

describe("confidential transfer tool", () => {
  it("executes a policy-compliant transfer", async () => {
    const { tool, execute } = makeTool();
    const result = await tool.run(validTransfer);

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    if (result.ok) expect(result.transaction.signature).toBe(authorizedTx.signature);
  });

  it("refuses a transfer that breaks the policy and never calls the executor", async () => {
    const { tool, execute } = makeTool();
    const result = await tool.run({ ...validTransfer, proposedAmount: 999_999_999n });

    expect(result.ok).toBe(false);
    // The critical assertion: a rejected proposal must not reach the chain at all.
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the refusal as a readable observation rather than throwing", async () => {
    const { tool } = makeTool();
    const result = await tool.run({ ...validTransfer, proposedAmount: 999_999_999n });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toMatch(/per-transfer limit/);
  });

  it("refuses an off-allow-list recipient even when the amount is fine", async () => {
    const { tool, execute } = makeTool({
      policy: { ...defaultPolicy, allowedRecipients: ["TrustedRecipient"] },
    });
    const result = await tool.run({ ...validTransfer, recipient: "AttackerWallet" });

    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses when the period budget is already exhausted", async () => {
    const { tool, execute } = makeTool({
      getContext: async () => ({ spentThisPeriod: 50_000_000n, availableBalance: 100_000_000n }),
    });
    const result = await tool.run(validTransfer);

    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute for non-transfer actions", async () => {
    const { tool, execute } = makeTool();
    const result = await tool.run({ action: "hold", reasoning: "waiting" });

    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("re-reads live context on every call instead of caching it", async () => {
    const getContext = vi
      .fn()
      .mockResolvedValueOnce({ spentThisPeriod: 0n, availableBalance: 100_000_000n })
      .mockResolvedValueOnce({ spentThisPeriod: 50_000_000n, availableBalance: 100_000_000n });
    const { tool } = makeTool({ getContext });

    expect((await tool.run(validTransfer)).ok).toBe(true);
    // Same proposal, budget now spent — must be refused on the second call.
    expect((await tool.run(validTransfer)).ok).toBe(false);
    expect(getContext).toHaveBeenCalledTimes(2);
  });
});
