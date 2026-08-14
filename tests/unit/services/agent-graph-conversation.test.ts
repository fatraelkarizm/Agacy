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

  it("asks for an amount before planning a consequential payment", async () => {
    const result = await expandAgentGraph({
      goal: "Pay the vendor confidentially.",
      parent: { label: "Pay vendor", detail: "Pay vendor", kind: "agent" },
      depth: 0,
      lineage: ["Pay vendor"],
      availableTools: ["pay_confidentially"],
    });

    expect(result.children).toEqual([expect.objectContaining({
      label: "Clarification needed",
      kind: "blocked",
      detail: expect.stringContaining("not an arbitrary vendor wallet"),
    })]);
  });

  it("asks before substituting the provisioned demo recipient for a vendor", async () => {
    const result = await expandAgentGraph({
      goal: "Pay the vendor 2 tokens confidentially.",
      parent: { label: "Pay vendor", detail: "Pay vendor", kind: "agent" },
      depth: 0,
      lineage: ["Pay vendor"],
      availableTools: ["pay_confidentially"],
    });

    expect(result.children[0]).toMatchObject({
      label: "Clarification needed",
      kind: "blocked",
      detail: expect.stringContaining("Should I use the provisioned demo recipient"),
    });
  });

  it("rejects an out-of-range payment amount before any tool is planned", async () => {
    const result = await expandAgentGraph({
      goal: "Pay the vendor 8 tokens confidentially.",
      parent: { label: "Pay vendor", detail: "Pay vendor", kind: "agent" },
      depth: 0,
      lineage: ["Pay vendor"],
      availableTools: ["pay_confidentially"],
    });

    expect(result.children[0]).toMatchObject({
      label: "Clarification needed",
      kind: "blocked",
    });
  });

  it("answers Agacy privacy questions without inventing tool work", async () => {
    const result = await expandAgentGraph({
      goal: "What does Agacy encrypt?",
      parent: { label: "Privacy question", detail: "Privacy question", kind: "agent" },
      depth: 0,
      lineage: ["Privacy question"],
      availableTools: tools,
    });

    expect(result.children).toEqual([expect.objectContaining({
      label: "Agacy privacy boundary",
      kind: "complete",
      detail: expect.stringContaining("timing, fees, and program interactions remain public"),
    })]);
  });

  it("answers capability questions with the actual supported scope", async () => {
    const result = await expandAgentGraph({
      goal: "What can you do?",
      parent: { label: "Capabilities", detail: "Capabilities", kind: "agent" },
      depth: 0,
      lineage: ["Capabilities"],
      availableTools: tools,
    });

    expect(result.children[0]).toMatchObject({
      label: "Available capabilities",
      kind: "complete",
    });
    expect(result.children[0]?.detail).toContain("explicit token amount");
  });

  it.each([
    ["Hi", []],
    ["Check my wallet overview.", ["get_wallet_overview"]],
    ["Research whether the vendor reported a breach.", ["research_counterparty"]],
    ["Pay the provisioned demo recipient for the approved 2-token invoice confidentially.", ["pay_confidentially"]],
    [
      "Verify the price using two independent sources, then settle the invoice.",
      ["get_token_price", "cross_check_token_price", "pay_confidentially"],
    ],
  ])("limits tools to the goal: %s", (goal, expected) => {
    expect(relevantToolsForGoal(goal, tools)).toEqual(expected);
  });
});
