import { describe, expect, it } from "vitest";
import {
  agentGraphExpansionRequestSchema,
  agentGraphExpansionSchema,
  agentGraphToolCallSchema,
} from "../../../server/schema/agent-graph.schema";

describe("agent graph schemas", () => {
  it("accepts a bounded request with an explicit tool allow-list", () => {
    expect(agentGraphExpansionRequestSchema.safeParse({
      goal: "Inspect the wallet.",
      parent: { label: "Inspect", detail: "Inspect the wallet.", kind: "agent" },
      depth: 0,
      lineage: ["Inspect"],
      availableTools: ["get_wallet_overview"],
    }).success).toBe(true);
  });

  it("accepts a bounded recursive expansion", () => {
    expect(agentGraphExpansionSchema.safeParse({
      children: [{
        label: "Inspect wallet policy",
        detail: "Read the current owner policy before proposing an action.",
        kind: "policy",
        expand: true,
      }],
    }).success).toBe(true);
  });

  it("bounds merged tool observations before they reach the planner", () => {
    const parsed = agentGraphExpansionRequestSchema.parse({
      goal: "Check the wallet, policy, and provider status before paying.",
      parent: { label: "Verified observations", detail: "x".repeat(1_200), kind: "observe" },
      depth: 1,
      lineage: ["Goal", "Verified observations"],
      availableTools: ["pay_confidentially"],
    });

    expect(parsed.parent.detail).toHaveLength(500);
  });

  it("rejects empty goals and excessive depth", () => {
    const request = {
      goal: "",
      parent: { label: "AI Agent", detail: "Owner goal", kind: "agent" },
      depth: 5,
      lineage: ["AI Agent"],
    };

    expect(agentGraphExpansionRequestSchema.safeParse(request).success).toBe(false);
  });

  it("accepts only registered structured tool calls", () => {
    expect(agentGraphToolCallSchema.safeParse({
      name: "authorize_policy_spend",
      input: {
        amountTokens: 4.25,
        recipient: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK",
        reasoning: "Renew the owner-approved subscription.",
      },
    }).success).toBe(true);
    expect(agentGraphToolCallSchema.safeParse({
      name: "run_arbitrary_command",
      input: {},
    }).success).toBe(false);
  });
});
