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
    goal: "Proposal AGP-27 passed and the contributor milestone was accepted. Confirm the treasury can cover the approved 2-token payout, then release it confidentially so the contributor's compensation and the DAO's runway are not exposed publicly.",
  },
  {
    id: "sme-procurement",
    persona: "Startup / SME procurement",
    goal: "Our monthly Solana RPC vendor invoice has been approved for payment. Verify the SOL reference price at mint So11111111111111111111111111111111111111112 using two independent sources, check for any recent vendor outage or security incident, then settle the 1-token invoice confidentially so competitors cannot infer our supplier rate.",
  },
  {
    id: "protocol-keeper",
    persona: "Web3 protocol / agent platform",
    goal: "The protocol's weekly keeper epoch has closed and the operator completed its assigned jobs. Confirm the operations wallet can cover the approved 1-token keeper reward, then settle it confidentially so the protocol does not publish operator compensation or treasury balance.",
  },
  {
    id: "individual",
    persona: "Individual power user",
    goal: "My monthly market-data subscription is due for renewal at its usual 1-token rate. Check that my wallet can cover it and whether the provider has reported a recent breach or outage that should stop renewal, then pay confidentially so the subscription amount is not added to my public spending profile.",
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
  const toolCalls = expansion.children.flatMap((child) => child.toolCall ? [child.toolCall] : []);

  results.push({
    id: persona.id,
    persona: persona.persona,
    goal: persona.goal,
    firstExpansionMs: elapsedMs,
    children: expansion.children.length,
    toolsChosen,
    toolCalls,
    steps: expansion.children.map((child) => ({
      label: child.label,
      kind: child.kind,
      expand: child.expand,
      ...(child.toolCall ? { toolCall: child.toolCall } : {}),
    })),
    labels: expansion.children.map((child) => child.label),
  });

  console.log(`${persona.persona}: ${elapsedMs}ms, ${expansion.children.length} children`);
  console.log(`  tools: ${toolsChosen.join(", ") || "(none in first expansion)"}`);
  for (const call of toolCalls) console.log(`  call: ${call.name} ${JSON.stringify(call.input)}`);
  for (const child of expansion.children) {
    console.log(`  - [${child.kind}${child.expand ? ", expands" : ""}] ${child.label}`);
  }
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
