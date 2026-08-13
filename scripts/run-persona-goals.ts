import "../tests/setup-env.js";
import { writeFileSync } from "node:fs";
import { expandAgentGraph } from "../server/services/agent-graph.js";
import type { AgentGraphToolName } from "../server/dto/agent-graph.dto.js";

/**
 * Runs one goal per README persona and records what actually happened.
 *
 * The README claims four target users. Nothing in the repo showed those users'
 * workflows actually completing, so the claim rested on assertion. This drives
 * each persona's goal through the real expansion service against the real
 * model, and writes the timings and tool choices to an artefact the README can
 * cite.
 *
 * Tool *execution* stays in the browser — the handlers call this app's own API
 * routes, which do not exist outside Next. So this measures the planning half
 * honestly and says so; the browser run is what proves execution.
 *
 * Run with: npx tsx scripts/run-persona-goals.ts
 */

interface Persona {
  readonly id: string;
  readonly persona: string;
  readonly goal: string;
}

const AVAILABLE: AgentGraphToolName[] = [
  "get_wallet_overview",
  "get_token_price",
  "cross_check_token_price",
  "research_counterparty",
  "pay_confidentially",
  "get_swap_quote",
];

const PERSONAS: readonly Persona[] = [
  {
    id: "dao-treasury",
    persona: "DAO treasury operator",
    goal: "I run a DAO treasury and a contributor payout is due. Check my wallet overview, search the web for any recent Solana security incident that should stop the payment, then pay 2 tokens confidentially so our runway stays private.",
  },
  {
    id: "sme-procurement",
    persona: "Startup / SME procurement",
    goal: "Our SaaS vendor invoice is due. Price SOL at mint So11111111111111111111111111111111111111112 and cross-check that price against an independent source, then pay 1 token confidentially so our supplier pricing does not become public.",
  },
  {
    id: "protocol-keeper",
    persona: "Web3 protocol / agent platform",
    goal: "I am a protocol settling a keeper's fee. Cross-check the SOL price at mint So11111111111111111111111111111111111111112 against an independent source, check my wallet overview, then settle 1 token confidentially.",
  },
  {
    id: "individual",
    persona: "Individual power user",
    goal: "Renew my monthly market data subscription. Search the web for any recent Solana security incident, price SOL at mint So11111111111111111111111111111111111111112, then pay 1 token confidentially so my spending profile stays private.",
  },
];

const results = [];

for (const persona of PERSONAS) {
  const started = Date.now();
  const expansion = await expandAgentGraph({
    goal: persona.goal,
    parent: { label: persona.persona, detail: persona.goal.slice(0, 240), kind: "agent" },
    depth: 0,
    lineage: ["AI Agent"],
    availableTools: AVAILABLE,
  });
  const elapsedMs = Date.now() - started;

  const toolsChosen = expansion.children
    .map((child) => child.toolCall?.name)
    .filter((name): name is AgentGraphToolName => name !== undefined);

  results.push({
    id: persona.id,
    persona: persona.persona,
    goal: persona.goal,
    firstExpansionMs: elapsedMs,
    children: expansion.children.length,
    toolsChosen,
    labels: expansion.children.map((child) => child.label),
  });

  console.log(`${persona.persona}: ${elapsedMs}ms, ${expansion.children.length} children`);
  console.log(`  tools: ${toolsChosen.join(", ") || "(none in first expansion)"}`);
  for (const label of expansion.children.map((child) => child.label)) console.log(`  - ${label}`);
  console.log();
}

writeFileSync(
  "server/data/persona-runs.json",
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      note:
        "First-expansion planning only. Tool execution happens in the browser because the handlers call this app's API routes.",
      model: process.env["LLM_MODEL"] ?? "gpt-4o-mini",
      availableTools: AVAILABLE,
      personas: results,
    },
    null,
    2,
  )}\n`,
);
console.log("saved -> server/data/persona-runs.json");
