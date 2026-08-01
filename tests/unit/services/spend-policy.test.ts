import { describe, it, expect } from "vitest";
import { evaluateSpendPolicy, type PolicyContext } from "@services/spend-policy";
import type { AgentDecisionDTO, SpendPolicyDTO } from "@dto/agent.dto";
import { defaultPolicy } from "../../fixtures/transactions";

function transfer(amount: bigint, recipient = "RecipientA"): AgentDecisionDTO {
  return { action: "transfer", reasoning: "test", proposedAmount: amount, recipient };
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    policy: defaultPolicy,
    spentThisPeriod: 0n,
    availableBalance: 100_000_000n,
    ...overrides,
  };
}

describe("spend policy", () => {
  it("allows a transfer within every limit", () => {
    expect(evaluateSpendPolicy(transfer(1_000_000n), context()).compliant).toBe(true);
  });

  it("allows non-transfer decisions unconditionally", () => {
    const hold: AgentDecisionDTO = { action: "hold", reasoning: "waiting for a better price" };
    expect(evaluateSpendPolicy(hold, context()).compliant).toBe(true);
  });

  it("rejects a transfer above the per-transfer limit", () => {
    const verdict = evaluateSpendPolicy(transfer(10_000_001n), context());
    expect(verdict.compliant).toBe(false);
    expect(verdict.reason).toMatch(/per-transfer limit/);
  });

  it("allows a transfer exactly at the per-transfer limit", () => {
    expect(evaluateSpendPolicy(transfer(10_000_000n), context()).compliant).toBe(true);
  });

  it("rejects a transfer that would breach the period limit", () => {
    const verdict = evaluateSpendPolicy(
      transfer(5_000_000n),
      context({ spentThisPeriod: 46_000_000n }),
    );
    expect(verdict.compliant).toBe(false);
    expect(verdict.reason).toMatch(/period limit/);
  });

  it("reports the remaining period allowance in the rejection reason", () => {
    const verdict = evaluateSpendPolicy(
      transfer(5_000_000n),
      context({ spentThisPeriod: 46_000_000n }),
    );
    expect(verdict.reason).toContain("4000000");
  });

  it("never reports a negative remaining allowance", () => {
    const verdict = evaluateSpendPolicy(
      transfer(1n),
      context({ spentThisPeriod: 60_000_000n }),
    );
    expect(verdict.reason).toContain("only 0 remains");
  });

  it("rejects a transfer exceeding the available balance", () => {
    const verdict = evaluateSpendPolicy(transfer(500n), context({ availableBalance: 499n }));
    expect(verdict.compliant).toBe(false);
    expect(verdict.reason).toMatch(/available balance/);
  });

  it("rejects zero and negative amounts", () => {
    expect(evaluateSpendPolicy(transfer(0n), context()).compliant).toBe(false);
    expect(evaluateSpendPolicy(transfer(-5n), context()).compliant).toBe(false);
  });

  it("rejects a transfer decision with no amount", () => {
    const malformed: AgentDecisionDTO = { action: "transfer", reasoning: "oops" };
    const verdict = evaluateSpendPolicy(malformed, context());
    expect(verdict.compliant).toBe(false);
    expect(verdict.reason).toMatch(/missing an amount/);
  });

  describe("recipient allow-list", () => {
    const restricted: SpendPolicyDTO = { ...defaultPolicy, allowedRecipients: ["RecipientA"] };

    it("allows a recipient on the list", () => {
      const verdict = evaluateSpendPolicy(
        transfer(1_000n, "RecipientA"),
        context({ policy: restricted }),
      );
      expect(verdict.compliant).toBe(true);
    });

    it("rejects a recipient not on the list", () => {
      const verdict = evaluateSpendPolicy(
        transfer(1_000n, "AttackerWallet"),
        context({ policy: restricted }),
      );
      expect(verdict.compliant).toBe(false);
      expect(verdict.reason).toMatch(/allow-list/);
    });

    it("treats an empty allow-list as unrestricted", () => {
      const verdict = evaluateSpendPolicy(transfer(1_000n, "AnyoneAtAll"), context());
      expect(verdict.compliant).toBe(true);
    });
  });
});
