import { describe, expect, it, vi } from "vitest";
import { createVercelAITools, type Action } from "solana-agent-kit";
import {
  createAgacyGraphPlugin,
  createGraphActions,
  goalAuthorizesTokenAmount,
  GRAPH_ACTION_DESCRIPTIONS,
} from "@agent/graph-actions";
import { agentGraphToolNameSchema } from "../../../server/schema/agent-graph.schema";
import type { SolanaClient } from "../../../server/data/solana-client";

/**
 * The graph's tools are Agent Kit `Action` objects so the same registry can be
 * driven by the graph in the browser and by Agent Kit's real orchestration loop
 * on a server. These tests hold that claim to Agent Kit's actual runtime rather
 * than to a hand-written idea of the interface: `createVercelAITools` is the
 * adapter a real consumer would use, so if the actions are malformed it fails
 * here rather than in front of someone.
 */

const context = {
  client: {} as SolanaClient,
  ownerAddress: "5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5",
  policy: { maxPerTransfer: 20_000_000n, maxPerPeriod: 80_000_000n, allowedRecipients: [] },
  policyAccount: null,
  agentSigner: null,
  spentThisPeriod: 4_000_000n,
  ownerGoal: "Inspect my wallet.",
};
const VENDOR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const actions = createGraphActions(context);

describe("graph actions as Agent Kit actions", () => {
  it("satisfies every field Agent Kit's Action interface requires", () => {
    for (const action of actions) {
      expect(typeof action.name, `${action.name} name`).toBe("string");
      expect(action.name.length).toBeGreaterThan(0);
      expect(Array.isArray(action.similes), `${action.name} similes`).toBe(true);
      expect(action.similes.length, `${action.name} needs at least one simile`).toBeGreaterThan(0);
      expect(action.description.length, `${action.name} description`).toBeGreaterThan(20);
      expect(Array.isArray(action.examples), `${action.name} examples`).toBe(true);
      expect(action.examples.length, `${action.name} needs an example group`).toBeGreaterThan(0);
      expect(action.examples[0]?.length, `${action.name} needs an example`).toBeGreaterThan(0);
      expect(typeof action.handler, `${action.name} handler`).toBe("function");
      // A schema Agent Kit can actually parse, not just any object.
      expect(action.schema.safeParse({}).success !== undefined).toBe(true);
    }
  });

  it("is accepted by Agent Kit's own Vercel AI adapter", () => {
    // The real adapter, not a stand-in. It reads name, description, similes,
    // examples and schema off every action, so a malformed one fails here.
    //
    // Note it keys the result by *numeric index*, not by action name
    // (`tools[index.toString()]` in solana-agent-kit 2.0.10). That is Agent
    // Kit's own behaviour, so this asserts the count and the parameter wiring
    // rather than the keys — see agent/autonomous-loop.ts, which re-keys by
    // name before handing the tools to a model.
    const tools = createVercelAITools({} as never, actions as Action[]);

    expect(Object.keys(tools)).toHaveLength(actions.length);
    for (const [index, action] of actions.entries()) {
      const tool = tools[String(index)];
      expect(tool, `action ${action.name} produced no tool`).toBeDefined();
      expect(tool?.parameters).toBe(action.schema);
      expect(String(tool?.description)).toContain(action.description);
    }
  });

  it("exposes exactly the tools the graph's wire schema knows about", () => {
    expect(actions.map((action) => action.name).sort())
      .toEqual([...agentGraphToolNameSchema.options].sort());
  });

  it("describes every tool from the single shared description registry", () => {
    for (const action of actions) {
      const shared = GRAPH_ACTION_DESCRIPTIONS[action.name as keyof typeof GRAPH_ACTION_DESCRIPTIONS];
      expect(action.description, `${action.name} must not carry its own copy`).toBe(shared);
    }
  });

  it("packages the same actions as an Agent Kit plugin", () => {
    const plugin = createAgacyGraphPlugin(context);

    expect(plugin.name).toBe("agacy-graph");
    expect(plugin.actions.map((action) => action.name).sort())
      .toEqual(actions.map((action) => action.name).sort());
    expect(typeof plugin.initialize).toBe("function");
  });
});

describe("graph action handlers", () => {
  it("runs without an agent instance, since dependencies are injected", async () => {
    const overview = actions.find((action) => action.name === "get_wallet_overview");
    const result = await overview!.handler(undefined as never, {});

    expect(result["status"]).toBe("succeeded");
    // Owner detail belongs in summary only; the model-facing field stays redacted.
    expect(String(result["summary"])).toContain(context.ownerAddress);
    expect(String(result["modelSummary"])).not.toContain(context.ownerAddress);
  });

  it("validates input through the action schema instead of trusting the caller", async () => {
    const price = actions.find((action) => action.name === "get_token_price");

    await expect(price!.handler(undefined as never, { mint: "too-short" }))
      .rejects.toThrow();
  });

  it("refuses a spend the owner goal never authorised", async () => {
    const authorize = actions.find((action) => action.name === "authorize_policy_spend");
    const result = await authorize!.handler(undefined as never, {
      amountTokens: 5,
      recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      reasoning: "Not something the owner asked for.",
    });

    // policyAccount is null here, so it stops before reaching the chain.
    expect(result["status"]).toBe("blocked");
  });

  it("blocks a model-invented confidential payment amount", async () => {
    const payment = actions.find((action) => action.name === "pay_confidentially");
    const result = await payment!.handler(undefined as never, {
      amountTokens: 5,
      mode: "confidential",
    });

    expect(result["status"]).toBe("blocked");
    expect(String(result["summary"])).toContain("must explicitly authorize 5 tokens");
  });

  it("blocks an amount when the owner did not approve the imported vendor", async () => {
    const payment = createGraphActions({
      ...context,
      ownerGoal: "Pay the vendor 2 tokens confidentially.",
    }).find((action) => action.name === "pay_confidentially");
    const result = await payment!.handler(undefined as never, {
      amountTokens: 2,
      mode: "confidential",
    });

    expect(result["status"]).toBe("blocked");
    expect(String(result["summary"])).toContain("imported vendor wallet");
  });

  it("executes only when amount and imported vendor both match the owner goal", async () => {
    const execute = vi.fn(async () => ({
      mode: "confidential" as const,
      signature: "signature",
      mint: VENDOR,
      recipient: VENDOR,
      amountTokens: 2,
      amountReadableOnChain: false,
      elapsedMs: 100,
      explorerUrl: "https://explorer.solana.com",
    }));
    const payment = createGraphActions({
      ...context,
      ownerGoal: `Pay ${VENDOR} exactly 2 tokens confidentially.`,
      paymentRecipient: VENDOR,
      executeConfidentialPayment: execute,
    }).find((action) => action.name === "pay_confidentially");

    const result = await payment!.handler(undefined as never, { amountTokens: 2 });
    expect(result["status"]).toBe("succeeded");
    expect(execute).toHaveBeenCalledWith(2, "confidential");
  });

  it("only recognizes token-adjacent amounts as payment authority", () => {
    expect(goalAuthorizesTokenAmount("Pay the approved 2-token invoice.", 2)).toBe(true);
    expect(goalAuthorizesTokenAmount("Pay 2.5 tokens confidentially.", 2.5)).toBe(true);
    expect(goalAuthorizesTokenAmount("Proposal 5 says to pay the vendor.", 5)).toBe(false);
    expect(goalAuthorizesTokenAmount("Pay 2 tokens confidentially.", 5)).toBe(false);
  });
});
