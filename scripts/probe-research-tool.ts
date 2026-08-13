import "../tests/setup-env.js";
import { expandAgentGraph } from "../server/services/agent-graph.js";

/**
 * Why did the model's web-search step come back blocked?
 *
 * `normalizeExpansion` converts a `kind=tool` child into a blocked node when the
 * tool call is missing or names a tool that is not on offer — and both look
 * identical from the browser. This prints what the model actually emitted.
 *
 * Run with: npx tsx scripts/probe-research-tool.ts
 */

const result = await expandAgentGraph({
  goal: "I am about to pay a vendor in SOL. Search the web for any recent Solana security incident I should know about before I proceed.",
  parent: {
    label: "Check for recent incidents",
    detail: "Owner wants open-web due diligence before paying a vendor.",
    kind: "agent",
  },
  depth: 0,
  lineage: ["AI Agent"],
  availableTools: ["get_wallet_overview", "research_counterparty", "get_token_price"],
});

for (const child of result.children) {
  console.log(`kind=${child.kind.padEnd(8)} expand=${String(child.expand).padEnd(5)} ${child.label}`);
  console.log(`   detail: ${child.detail}`);
  console.log(`   toolCall: ${child.toolCall ? JSON.stringify(child.toolCall) : "(none)"}\n`);
}
