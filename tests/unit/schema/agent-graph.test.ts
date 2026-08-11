import { describe, expect, it } from "vitest";
import {
  agentGraphExpansionRequestSchema,
  agentGraphExpansionSchema,
} from "../../../server/schema/agent-graph.schema";

describe("agent graph schemas", () => {
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

  it("rejects empty goals and excessive depth", () => {
    const request = {
      goal: "",
      parent: { label: "AI Agent", detail: "Owner goal", kind: "agent" },
      depth: 5,
      lineage: ["AI Agent"],
    };

    expect(agentGraphExpansionRequestSchema.safeParse(request).success).toBe(false);
  });
});
