import { describe, expect, it } from "vitest";
import { buildAttackSimulation, buildAuthorizedDemoHistory } from "@services/demo-scenario";

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

describe("attack simulation", () => {
  it("produces nothing before any transaction has run — there is nothing to attack yet", () => {
    expect(buildAttackSimulation([], 250_000_000n)).toEqual([]);
  });

  it("marks every exposed-wallet step as revealed and every confidential step as blocked", () => {
    const steps = buildAttackSimulation(
      [{ amount: 4_200_000n, recipient: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK", reasoning: "test" }],
      245_800_000n,
    );

    const exposedSteps = steps.filter((s) => s.target === "exposed");
    const confidentialSteps = steps.filter((s) => s.target === "confidential");

    expect(exposedSteps.length).toBeGreaterThan(0);
    expect(confidentialSteps.length).toBeGreaterThan(0);
    expect(exposedSteps.every((s) => s.outcome === "revealed")).toBe(true);
    expect(confidentialSteps.every((s) => s.outcome === "blocked")).toBe(true);
  });

  it("uses the real last execution and balance in the narrative, not a canned example", () => {
    const steps = buildAttackSimulation(
      [
        { amount: 1_000_000n, recipient: "First111", reasoning: "first" },
        { amount: 7_777_000n, recipient: "SecondRecipient222", reasoning: "second" },
      ],
      99_000_000n,
    );

    const sizeExposed = steps.find((s) => s.id === "size-exposed");
    const scanExposed = steps.find((s) => s.id === "scan-exposed");

    expect(sizeExposed?.detail).toContain("99.00");
    // Reflects the *last* execution, not the first, since that's what a real
    // explorer scan would surface as the most recent activity.
    expect(scanExposed?.detail).toContain("7.77");
    expect(scanExposed?.detail).toContain("SecondReci");
  });

  it("every step has a human-readable narrative and detail", () => {
    const steps = buildAttackSimulation(
      [{ amount: 1n, recipient: "R", reasoning: "r" }],
      1n,
    );
    for (const step of steps) {
      expect(step.narrative.length).toBeGreaterThan(0);
      expect(step.detail.length).toBeGreaterThan(0);
    }
  });
});
