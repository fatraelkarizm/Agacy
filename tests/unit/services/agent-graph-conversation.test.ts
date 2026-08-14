import { describe, expect, it } from "vitest";
import { expandAgentGraph } from "@services/agent-graph";

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
});
