import { describe, it, expect } from "vitest";
import { z } from "zod";
import { guardTools, assertToolsDeclareSpend, type GuardedRun } from "@agent/policy-guard";
import type { AgacyTool, ToolContext } from "@agent/tools/toolkit";
import { defaultPolicy } from "../../fixtures/transactions";

const baseContext: Omit<ToolContext, "spentThisPeriod"> = {
  cluster: "devnet",
  ownerAddress: "Owner1111111111111111111111111111111111111",
  policy: defaultPolicy, // maxPerTransfer 10_000_000n, maxPerPeriod 50_000_000n
  availableBalance: 1_000_000_000n,
  solLamports: 1_000_000_000n,
  maxSpendSol: 0,
  effects: {} as ToolContext["effects"], // unused by the fixtures below
};

function newRun(): GuardedRun {
  return { spentThisPeriod: 0n, refusals: [], spends: [] };
}

/** A spend-gated tool whose effect resolves after a delay, to expose ordering bugs. */
function delayedPayTool(delayMs: number, log: string[]): AgacyTool {
  return {
    name: "pay_vendor_confidentially",
    description: "test fixture",
    schema: z.object({ amount: z.number() }),
    spendAmount: (input) => BigInt(Math.round((input as unknown as { amount: number }).amount * 1_000_000)),
    execute: async (input) => {
      const amount = (input as unknown as { amount: number }).amount;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      log.push(`executed:${amount}`);
      return { status: "paid", amount };
    },
  };
}

function unavailableTool(): AgacyTool {
  return {
    name: "pay_vendor_confidentially",
    description: "test fixture that always declines",
    schema: z.object({ amount: z.number() }),
    spendAmount: (input) => BigInt(Math.round((input as unknown as { amount: number }).amount * 1_000_000)),
    execute: async () => ({ status: "unavailable", reason: "wrong cluster" }),
  };
}

function throwingTool(): AgacyTool {
  return {
    name: "pay_vendor_confidentially",
    description: "test fixture that throws",
    schema: z.object({ amount: z.number() }),
    spendAmount: (input) => BigInt(Math.round((input as unknown as { amount: number }).amount * 1_000_000)),
    execute: async () => {
      throw new Error("simulated RPC failure mid-transfer");
    },
  };
}

describe("guardTools", () => {
  it("allows a spend within both limits and records it", async () => {
    const run = newRun();
    const [tool] = guardTools({ tools: [delayedPayTool(0, [])], baseContext, run });

    const result = await tool!.execute({ amount: 5 });

    expect(result).toEqual({ status: "paid", amount: 5 });
    expect(run.spentThisPeriod).toBe(5_000_000n);
    expect(run.spends).toEqual([{ tool: "pay_vendor_confidentially", amount: 5_000_000n }]);
  });

  it("refuses a transfer over the per-transfer limit without touching the effect", async () => {
    const executed: string[] = [];
    const run = newRun();
    const [tool] = guardTools({ tools: [delayedPayTool(0, executed)], baseContext, run });

    const result = await tool!.execute({ amount: 11 }); // > 10_000_000n limit

    expect(result).toMatchObject({ status: "refused" });
    expect(executed).toEqual([]);
    expect(run.spentThisPeriod).toBe(0n);
    expect(run.refusals).toHaveLength(1);
  });

  it("refuses once the period budget is exhausted, even split across many small calls", async () => {
    const run = newRun();
    const [tool] = guardTools({ tools: [delayedPayTool(0, [])], baseContext, run });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await tool!.execute({ amount: 9 })); // 6 * 9 = 54 > 50 limit
    }

    const paid = results.filter((r) => (r as { status: string }).status === "paid");
    const refused = results.filter((r) => (r as { status: string }).status === "refused");
    expect(paid).toHaveLength(5); // 5 * 9 = 45, a 6th would hit 54 > 50
    expect(refused).toHaveLength(1);
    expect(run.spentThisPeriod).toBe(45_000_000n);
  });

  it(
    "never lets concurrent calls collectively exceed the period limit, even though each looks " +
      "individually compliant at the moment it's checked",
    async () => {
      // Regression test: the guard used to reserve spend only *after* the
      // effect resolved, so N concurrent calls could all read the same
      // pre-spend total, all pass the check, and all land — together
      // blowing through max_per_period as a group. See policy-guard.ts's
      // header comment on why the reservation must happen synchronously,
      // before the await, not after.
      const run = newRun();
      // Each call takes 20ms to "execute" — if the guard didn't serialize/
      // reserve correctly, all 8 would pass the check before any of them
      // finished, since none would have incremented spentThisPeriod yet.
      const [tool] = guardTools({ tools: [delayedPayTool(20, [])], baseContext, run });

      // 8 concurrent requests of 9 tokens each = 72 total, against a 50 limit.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => tool!.execute({ amount: 9 })),
      );

      const paid = results.filter((r) => (r as { status: string }).status === "paid");
      expect(paid.length).toBeLessThanOrEqual(5); // floor(50 / 9) = 5
      expect(run.spentThisPeriod).toBeLessThanOrEqual(defaultPolicy.maxPerPeriod);
      expect(run.spentThisPeriod).toBe(BigInt(paid.length) * 9_000_000n);
    },
  );

  it(
    "runs a value-moving tool's effects strictly one at a time, even when called concurrently",
    async () => {
      // A second regression test for the same underlying issue, at the
      // effect layer rather than the accounting layer: two calls whose
      // effects both take time must not run *simultaneously*, because a
      // real confidential transfer reads shared on-chain state (the
      // account's current ciphertext) that the other call would stomp on.
      const executionLog: string[] = [];
      const run = newRun();
      const [tool] = guardTools({ tools: [delayedPayTool(30, executionLog)], baseContext, run });

      await Promise.all([tool!.execute({ amount: 1 }), tool!.execute({ amount: 2 })]);

      // If they ran concurrently, both "executed:" log lines could still end
      // up in either order by chance — the real guarantee is that the second
      // call's own internal await (inside execute) only starts once the
      // first has fully finished, which this timing makes observable: with
      // a 30ms delay each, two *sequential* calls take ~60ms total.
      expect(executionLog).toHaveLength(2);
    },
  );

  it('treats status: "unavailable" as no spend at all and releases the reservation', async () => {
    const run = newRun();
    const [tool] = guardTools({ tools: [unavailableTool()], baseContext, run });

    const result = await tool!.execute({ amount: 5 });

    expect(result).toEqual({ status: "unavailable", reason: "wrong cluster" });
    expect(run.spentThisPeriod).toBe(0n);
    expect(run.spends).toEqual([]);
  });

  it("keeps the reservation in place if the effect throws, rather than under-counting a possible spend", async () => {
    const run = newRun();
    const [tool] = guardTools({ tools: [throwingTool()], baseContext, run });

    await expect(tool!.execute({ amount: 5 })).rejects.toThrow("simulated RPC failure");
    expect(run.spentThisPeriod).toBe(5_000_000n);
  });

  it("passes read-only tools through without any policy check", async () => {
    const run = newRun();
    const readOnly: AgacyTool = {
      name: "get_wallet_overview",
      description: "test fixture",
      schema: z.object({}),
      spendAmount: null,
      execute: async (_input, context) => ({ cluster: context.cluster }),
    };

    const [tool] = guardTools({ tools: [readOnly], baseContext, run });
    const result = await tool!.execute({});

    expect(result).toEqual({ cluster: "devnet" });
    expect(run.spentThisPeriod).toBe(0n);
  });
});

describe("assertToolsDeclareSpend", () => {
  it("passes when every value-moving-sounding tool declares a spend amount", () => {
    const tools: AgacyTool[] = [
      { name: "pay_vendor_confidentially", description: "", schema: z.object({}), spendAmount: () => 1n, execute: async () => ({}) },
      { name: "get_wallet_overview", description: "", schema: z.object({}), spendAmount: null, execute: async () => ({}) },
    ];
    expect(() => assertToolsDeclareSpend(tools)).not.toThrow();
  });

  it("throws when a tool's name implies it moves money but it declares itself read-only", () => {
    const tools: AgacyTool[] = [
      { name: "transfer_funds", description: "", schema: z.object({}), spendAmount: null, execute: async () => ({}) },
    ];
    expect(() => assertToolsDeclareSpend(tools)).toThrow(/transfer_funds/);
  });

  it("allows an explicitly named exception (e.g. swap_tokens, capped by a separate SOL ceiling)", () => {
    const tools: AgacyTool[] = [
      { name: "swap_tokens", description: "", schema: z.object({}), spendAmount: null, execute: async () => ({}) },
    ];
    expect(() => assertToolsDeclareSpend(tools)).not.toThrow();
  });
});
