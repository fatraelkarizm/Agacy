import { describe, expect, it } from "vitest";
import { buildAuthorizedDemoHistory } from "@services/demo-scenario";

describe("dashboard demo history", () => {
  it("maps agent executions to deterministic owner-only transactions", () => {
    const history = buildAuthorizedDemoHistory(
      [
        { amount: 4_200_000n, recipient: "Subscription", reasoning: "Renewed API access." },
        { amount: 12_500_000n, recipient: "Compute", reasoning: "Bought compute credits." },
      ],
      25_000_000n,
    );

    expect(history).toHaveLength(2);
    expect(history[0]?.resultingBalance).toBe(20_800_000n);
    expect(history[1]?.resultingBalance).toBe(8_300_000n);
    expect(history[0]?.signature).not.toBe(history[1]?.signature);
    expect(history[1]?.agentReasoning).toBe("Bought compute credits.");
  });
});
