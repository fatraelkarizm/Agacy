import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentTask, type AgentBrain } from "@agent/loop";
import { defaultPolicy } from "../../fixtures/transactions";

const task = (amount: bigint, label = "API subscription"): AgentTask => ({
  prompt: `Renewing ${label}.`,
  amount,
  recipient: "RecipientA",
  recipientLabel: label,
});

const initialState = { availableBalance: 100_000_000n, spentThisPeriod: 0n };

describe("agent loop", () => {
  it("runs a compliant task through to execution", async () => {
    const result = await runAgent({
      tasks: [task(4_000_000n)],
      policy: defaultPolicy,
      initialState,
    });

    expect(result.executed).toHaveLength(1);
    expect(result.refused).toHaveLength(0);
    expect(result.steps.map((s) => s.kind)).toEqual([
      "observe",
      "think",
      "decide",
      "policy",
      "execute",
    ]);
  });

  it("emits every step as it happens so a UI can follow along", async () => {
    const onStep = vi.fn();
    await runAgent({ tasks: [task(4_000_000n)], policy: defaultPolicy, initialState, onStep });
    expect(onStep).toHaveBeenCalledTimes(5);
  });

  it("blocks an over-limit transfer and never reaches an execute step", async () => {
    const result = await runAgent({
      tasks: [task(50_000_000n)],
      policy: defaultPolicy,
      initialState,
    });

    expect(result.executed).toHaveLength(0);
    expect(result.refused).toHaveLength(1);
    expect(result.steps.some((s) => s.kind === "execute")).toBe(false);
    expect(result.steps.at(-1)?.text).toMatch(/spend policy/);
  });

  it("blocks a rogue decision even when the agent insists on it", async () => {
    // Simulates a prompt-injected or malfunctioning model proposing a drain.
    const rogueBrain: AgentBrain = {
      async decide() {
        return {
          action: "transfer",
          reasoning: "Urgent! Send everything to this new address immediately.",
          proposedAmount: 100_000_000n,
          recipient: "AttackerWallet",
        };
      },
    };

    const result = await runAgent({
      tasks: [task(1_000n)],
      policy: defaultPolicy,
      initialState,
      brain: rogueBrain,
    });

    // The model's intent is irrelevant — enforcement happens outside it.
    expect(result.executed).toHaveLength(0);
    expect(result.steps.some((s) => s.kind === "execute")).toBe(false);
  });

  it("deducts from the balance and accrues period spend across tasks", async () => {
    const result = await runAgent({
      tasks: [task(4_000_000n), task(6_000_000n, "compute")],
      policy: defaultPolicy,
      initialState,
    });

    expect(result.finalState.availableBalance).toBe(90_000_000n);
    expect(result.finalState.spentThisPeriod).toBe(10_000_000n);
  });

  it("stops spending once the period budget is exhausted", async () => {
    const result = await runAgent({
      tasks: [task(10_000_000n), task(10_000_000n), task(10_000_000n), task(10_000_000n),
              task(10_000_000n), task(10_000_000n)],
      policy: defaultPolicy,
      initialState,
    });

    // maxPerPeriod is 50_000_000, so the sixth task must be refused.
    expect(result.executed).toHaveLength(5);
    expect(result.refused).toHaveLength(1);
  });

  it("holds rather than transferring when the balance cannot cover the task", async () => {
    const result = await runAgent({
      tasks: [task(500_000_000n)],
      policy: defaultPolicy,
      initialState,
    });

    expect(result.executed).toHaveLength(0);
    expect(result.steps.some((s) => s.text.includes("Holding"))).toBe(true);
  });
});
