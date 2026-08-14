import { describe, expect, it } from "vitest";
import { expandAgentGraph, relevantToolsForGoal } from "@services/agent-graph";

const tools = [
  "get_wallet_overview",
  "get_token_price",
  "cross_check_token_price",
  "research_counterparty",
  "pay_confidentially",
  "get_swap_quote",
] as const;

describe("agent graph conversation", () => {
  it("answers a greeting once without inventing work", async () => {
    await expect(expandAgentGraph({
      goal: "Hi",
      parent: { label: "Hi", detail: "Hi", kind: "agent" },
      depth: 0,
      lineage: ["Hi"],
      availableTools: ["get_wallet_overview", "research_counterparty"],
    })).resolves.toEqual({
      children: [{
        label: "Ready",
        detail: "Hi. Give me a concrete goal and I will only use tools that goal actually requires.",
        kind: "complete",
        expand: false,
      }],
    });
  });

  it("stops after a verified confidential payment", async () => {
    await expect(expandAgentGraph({
      goal: "Pay the approved invoice confidentially.",
      parent: { label: "Verified observations", detail: "Payment result", kind: "observe" },
      depth: 2,
      lineage: ["AI Agent", "Verified observations"],
      availableTools: [],
      completedTools: ["pay_confidentially"],
      observations: ["The confidential payment settled and plaintext was absent."],
    })).resolves.toEqual({
      children: [{
        label: "Goal complete",
        detail: "The requested confidential payment settled and its privacy verification passed.",
        kind: "complete",
        expand: false,
      }],
    });
  });

  it.each([
    ["Hi", []],
    ["Check my wallet overview.", ["get_wallet_overview"]],
    ["Research whether the vendor reported a breach.", ["research_counterparty"]],
    ["Pay the approved 2-token invoice confidentially.", ["pay_confidentially"]],
    [
      "Verify the price using two independent sources, then settle the invoice.",
      ["get_token_price", "cross_check_token_price", "pay_confidentially"],
    ],
  ])("limits tools to the goal: %s", (goal, expected) => {
    expect(relevantToolsForGoal(goal, tools)).toEqual(expected);
  });
});
