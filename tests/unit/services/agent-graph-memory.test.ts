import { describe, expect, it } from "vitest";
import { executeAgentGraphTool } from "@services/agent-graph-tools";
import { agentGraphExpansionRequestSchema } from "../../../server/schema/agent-graph.schema";
import type { SolanaClient } from "../../../server/data/solana-client";

/**
 * The graph expands one node per request, so without carried observations the
 * model only ever sees its direct parent plus ancestor *labels*. Facts a
 * sibling branch established, or anything more than one node back, were
 * invisible — which is what made the agent re-request tools it had already run
 * and contradict things it had already verified.
 *
 * The memory it carries has to stay on the model side of the privacy boundary:
 * observations are built from `modelSummary`, never the owner-only `summary`,
 * so a longer run must not become a way to accumulate owner detail.
 */

const client = {} as SolanaClient;
const ownerAddress = "5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5";

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    goal: "Check the wallet, then decide.",
    parent: { label: "Verified observations", detail: "Two reads completed.", kind: "observe" },
    depth: 1,
    lineage: ["AI Agent", "Verified observations"],
    availableTools: ["get_wallet_overview"],
    ...overrides,
  };
}

describe("agent graph expansion request", () => {
  it("accepts carried observations", () => {
    const parsed = agentGraphExpansionRequestSchema.safeParse(
      baseRequest({ observations: ["get_wallet_overview -> succeeded: A policy exists."] }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.observations).toHaveLength(1);
  });

  it("still accepts a request with no observations, so the first expansion works", () => {
    expect(agentGraphExpansionRequestSchema.safeParse(baseRequest()).success).toBe(true);
  });

  it("caps carried observations so a long run cannot grow the prompt without limit", () => {
    const tooMany = Array.from({ length: 13 }, (_, index) => `observation ${index}`);
    expect(agentGraphExpansionRequestSchema.safeParse(baseRequest({ observations: tooMany })).success)
      .toBe(false);

    const atCap = Array.from({ length: 12 }, (_, index) => `observation ${index}`);
    expect(agentGraphExpansionRequestSchema.safeParse(baseRequest({ observations: atCap })).success)
      .toBe(true);
  });

  it("rejects an oversized single observation rather than truncating it silently", () => {
    const parsed = agentGraphExpansionRequestSchema.safeParse(
      baseRequest({ observations: ["x".repeat(401)] }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("observation memory and the privacy boundary", () => {
  it("carries no owner-only detail, because it is built from modelSummary", async () => {
    const result = await executeAgentGraphTool({
      call: { name: "get_wallet_overview", input: {} },
      ownerGoal: "Inspect my wallet.",
      client,
      ownerAddress,
      policy: {
        maxPerTransfer: 20_000_000n,
        maxPerPeriod: 80_000_000n,
        allowedRecipients: [],
      },
      policyAccount: null,
      agentSigner: null,
      spentThisPeriod: 4_000_000n,
    });

    // Mirrors how AgentGraphArena builds each entry.
    const observation = `get_wallet_overview -> ${result.status}: ${result.modelSummary}`;

    expect(observation).not.toContain(ownerAddress);
    expect(observation).not.toContain("20.00");
    expect(observation).not.toContain("80.00");
    // And it still says something useful, or carrying it would be pointless.
    expect(observation.length).toBeGreaterThan(40);
  });

  it("fits a real observation inside the schema's per-entry limit", async () => {
    const result = await executeAgentGraphTool({
      call: { name: "get_wallet_overview", input: {} },
      ownerGoal: "Inspect my wallet.",
      client,
      ownerAddress,
      policy: { maxPerTransfer: 20_000_000n, maxPerPeriod: 80_000_000n, allowedRecipients: [] },
      policyAccount: null,
      agentSigner: null,
      spentThisPeriod: 4_000_000n,
    });

    const observation = `get_wallet_overview -> ${result.status}: ${result.modelSummary}`;
    expect(
      agentGraphExpansionRequestSchema.safeParse(baseRequest({ observations: [observation] })).success,
    ).toBe(true);
  });
});
