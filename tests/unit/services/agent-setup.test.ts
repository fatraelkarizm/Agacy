import { describe, it, expect } from "vitest";
import {
  PURPOSE_PRESETS,
  toPolicyInitParams,
  toSpendPolicy,
  validateAgentDraft,
} from "@services/agent-setup";
import type { AgentDraftDTO } from "@dto/agent.dto";

function draft(overrides: Partial<AgentDraftDTO> = {}): AgentDraftDTO {
  return {
    name: "Subs bot",
    purpose: "subscriptions",
    ...PURPOSE_PRESETS.subscriptions,
    ...overrides,
  };
}

describe("agent draft validation", () => {
  it("accepts a well-formed draft", () => {
    expect(validateAgentDraft(draft())).toHaveLength(0);
  });

  it("requires a name", () => {
    expect(validateAgentDraft(draft({ name: "   " }))[0]?.field).toBe("name");
  });

  it("rejects non-positive limits", () => {
    expect(validateAgentDraft(draft({ maxPerTransfer: 0 })).length).toBeGreaterThan(0);
    expect(validateAgentDraft(draft({ maxPerPeriod: -1 })).length).toBeGreaterThan(0);
  });

  it("rejects a per-transfer limit above the period limit", () => {
    // Otherwise the first payment exhausts the budget and the "limit" is fiction.
    const issues = validateAgentDraft(draft({ maxPerTransfer: 500, maxPerPeriod: 100 }));
    expect(issues.some((i) => i.field === "maxPerTransfer")).toBe(true);
  });

  it("requires a period of at least one day", () => {
    expect(validateAgentDraft(draft({ periodDays: 0 }))[0]?.field).toBe("periodDays");
  });
});

describe("draft to on-chain policy params", () => {
  it("converts whole tokens to base units", () => {
    const params = toPolicyInitParams(draft({ maxPerTransfer: 20, maxPerPeriod: 100 }));
    expect(params.maxPerTransfer).toBe(20_000_000n);
    expect(params.maxPerPeriod).toBe(100_000_000n);
  });

  it("converts the period to seconds", () => {
    expect(toPolicyInitParams(draft({ periodDays: 7 })).periodSeconds).toBe(604_800n);
  });

  it("defaults to confidential, disallowing non-confidential credits", () => {
    expect(toPolicyInitParams(draft()).allowNonConfidentialCredits).toBe(false);
  });

  it("allows non-confidential credits only when public is chosen explicitly", () => {
    expect(toPolicyInitParams(draft({ visibility: "public" })).allowNonConfidentialCredits).toBe(
      true,
    );
  });

  it("refuses to build params from an invalid draft", () => {
    expect(() => toPolicyInitParams(draft({ maxPerTransfer: 0 }))).toThrow(/invalid draft/);
  });

  it("handles fractional token amounts without floating-point drift", () => {
    expect(toPolicyInitParams(draft({ maxPerTransfer: 0.1 })).maxPerTransfer).toBe(100_000n);
  });
});

describe("draft to off-chain spend policy", () => {
  it("produces limits matching the on-chain params", () => {
    const d = draft({ maxPerTransfer: 20, maxPerPeriod: 100 });
    const policy = toSpendPolicy(d);
    const params = toPolicyInitParams(d);

    // The two enforcement paths must agree, or the fast off-chain check would
    // reject payments the chain would accept (or worse, the reverse).
    expect(policy.maxPerTransfer).toBe(params.maxPerTransfer);
    expect(policy.maxPerPeriod).toBe(params.maxPerPeriod);
  });

  it("carries the recipient allow-list through", () => {
    expect(toSpendPolicy(draft({ allowedRecipients: ["TrustedA"] })).allowedRecipients).toEqual([
      "TrustedA",
    ]);
  });
});

describe("purpose presets", () => {
  it("every preset is itself valid", () => {
    for (const [purpose, preset] of Object.entries(PURPOSE_PRESETS)) {
      const issues = validateAgentDraft({
        name: "Test",
        purpose: purpose as AgentDraftDTO["purpose"],
        ...preset,
      });
      expect(issues, `preset "${purpose}" should be valid`).toHaveLength(0);
    }
  });

  it("every preset defaults to confidential", () => {
    for (const preset of Object.values(PURPOSE_PRESETS)) {
      expect(preset.visibility).toBe("confidential");
    }
  });
});
