import "../tests/setup-env.js";

/**
 * Does the Agent Graph still work when its model calls are routed through
 * AIsa's gateway?
 *
 * The only thing that matters here is structured output. `expandAgentGraph`
 * uses `generateObject`, which needs the provider to honour a JSON schema —
 * plenty of "OpenAI-compatible" gateways accept the request and then return
 * prose. Testing with a raw chat completion would prove nothing, so this calls
 * the real production function against the real schema.
 *
 * Run with: npx tsx scripts/probe-aisa.ts
 */

const key = process.env["AISA_SECRET_KEY"];
if (!key) {
  console.error("AISA_SECRET_KEY is not set in .env.local");
  process.exit(1);
}

// Point the graph at AIsa for this process only. Nothing is written to disk,
// so a failed probe cannot leave the app pointing at a broken endpoint.
process.env["LLM_API_KEY"] = key;
process.env["BASE_URL"] = "https://api.aisa.one/v1";

const { expandAgentGraph } = await import("../server/services/agent-graph.js");

const model = process.env["LLM_MODEL"] ?? "gpt-4o-mini";
console.log("routing through:", process.env["BASE_URL"]);
console.log("model:", model);

const started = Date.now();
try {
  const result = await expandAgentGraph({
    goal: "Price SOL at mint So11111111111111111111111111111111111111112 and report the number.",
    parent: {
      label: "Price SOL and report",
      detail: "Owner wants the current SOL price before deciding.",
      kind: "agent",
    },
    depth: 0,
    lineage: ["AI Agent"],
    availableTools: ["get_wallet_overview", "get_token_price", "get_swap_quote"],
  });

  console.log(`\nOK in ${Date.now() - started}ms — ${result.children.length} children\n`);
  for (const child of result.children) {
    const tool = child.toolCall ? `  [tool: ${child.toolCall.name}]` : "";
    console.log(`  ${child.kind.padEnd(9)} ${child.label}${tool}`);
  }
  console.log("\nStructured output is honoured. The graph can run on AIsa.");
} catch (error) {
  console.error(`\nFAILED after ${Date.now() - started}ms`);
  console.error(error instanceof Error ? error.message : error);
  console.error("\nThe graph cannot run on AIsa with this model. Keep the current BASE_URL.");
  process.exit(1);
}
