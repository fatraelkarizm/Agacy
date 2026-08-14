import "../tests/setup-env.js";
import { writeFileSync } from "node:fs";
import { expandAgentGraph } from "../server/services/agent-graph.js";
import type { AgentGraphToolName } from "../server/dto/agent-graph.dto.js";
import type { AgentPurpose } from "../server/dto/agent.dto.js";

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
  readonly agentPurpose: AgentPurpose;
  readonly goal: string;
  readonly expectedTools: readonly AgentGraphToolName[];
}

const AVAILABLE: AgentGraphToolName[] = [
  "get_wallet_overview",
  "get_token_price",
  "cross_check_token_price",
  "research_counterparty",
  "pay_confidentially",
  "get_swap_quote",
];
const ONBOARDED_VENDOR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const PERSONAS: readonly Persona[] = [
  {
    id: "dao-treasury",
    persona: "DAO treasury operator",
    agentPurpose: "custom",
    goal: `Proposal AGP-27 passed and the contributor milestone was accepted. Execute the approved 2-token confidential payment to onboarded contributor wallet ${ONBOARDED_VENDOR}. Prove the amount is hidden.`,
    expectedTools: ["pay_confidentially"],
  },
  {
    id: "sme-procurement",
    persona: "Startup / SME procurement",
    agentPurpose: "procurement",
    goal: `Our monthly Solana RPC vendor invoice has been approved. Check for any recent vendor outage or security incident, then execute a 1-token confidential payment to onboarded vendor wallet ${ONBOARDED_VENDOR}. The run is not complete until that payment settles.`,
    expectedTools: ["research_counterparty", "pay_confidentially"],
  },
  {
    id: "protocol-keeper",
    persona: "Web3 protocol / agent platform",
    agentPurpose: "custom",
    goal: `Pay onboarded operator wallet ${ONBOARDED_VENDOR} exactly 1 token confidentially for the approved keeper reward, then report the on-chain privacy verification.`,
    expectedTools: ["pay_confidentially"],
  },
  {
    id: "individual",
    persona: "Individual power user",
    agentPurpose: "subscriptions",
    goal: `My monthly market-data subscription is due for renewal at its usual 1-token rate. Check whether the provider has reported a recent breach or outage that should stop renewal, then execute a 1-token confidential payment to onboarded provider wallet ${ONBOARDED_VENDOR}.`,
    expectedTools: ["research_counterparty", "pay_confidentially"],
  },
];

const VERIFIED_OBSERVATION: Record<AgentGraphToolName, string> = {
  get_wallet_overview: "The wallet overview was verified and the requested payment is covered.",
  check_on_chain_policy: "The on-chain policy was verified.",
  authorize_policy_spend: "The requested spend was authorized; no payment occurred yet.",
  get_token_price: "The primary token reference price was verified.",
  cross_check_token_price: "An independent source confirmed the reference price.",
  research_counterparty: "No recent incident was found that should block the requested action.",
  pay_confidentially: "The confidential devnet payment settled and the plaintext amount was absent on-chain.",
  get_swap_quote: "A read-only swap quote was verified; no swap executed.",
};

const results = [];

for (const persona of PERSONAS) {
  let parent = { label: persona.persona, detail: persona.goal.slice(0, 240), kind: "agent" as const };
  let depth = 0;
  let lineage = ["AI Agent"];
  let elapsedMs = 0;
  let terminal = false;
  const observations: string[] = [];
  const toolsChosen: AgentGraphToolName[] = [];
  const steps: Array<Record<string, unknown>> = [];
  const violations: string[] = [];

  for (let round = 1; round <= 4; round += 1) {
    const started = Date.now();
    const expansion = await expandAgentGraph({
      goal: persona.goal,
      agentPurpose: persona.agentPurpose,
      parent,
      depth,
      lineage,
      observations,
      completedTools: toolsChosen,
      availableTools: AVAILABLE.filter((tool) => !toolsChosen.includes(tool)),
    });
    elapsedMs += Date.now() - started;

    const toolCalls = expansion.children.flatMap((child) => child.toolCall ? [child.toolCall] : []);
    const expandable = expansion.children.filter((child) => child.expand);
    for (const child of expansion.children) {
      steps.push({
        round,
        label: child.label,
        kind: child.kind,
        expand: child.expand,
        ...(child.toolCall ? { toolCall: child.toolCall } : {}),
      });
      if (child.kind === "blocked") violations.push(`round ${round}: invented block: ${child.label}`);
    }

    if (toolCalls.length > 0) {
      if (expandable.length > 0) violations.push(`round ${round}: branched before tool observations`);
      for (const call of toolCalls) {
        if (toolsChosen.includes(call.name)) violations.push(`round ${round}: duplicate ${call.name}`);
        else toolsChosen.push(call.name);
        observations.push(VERIFIED_OBSERVATION[call.name]);
      }
      parent = {
        label: "Verified observations",
        detail: observations.slice(-toolCalls.length).join(" ").slice(0, 500),
        kind: "observe",
      };
      depth += 1;
      lineage = [...lineage, parent.label].slice(-5);
      continue;
    }

    if (expandable.length > 0) {
      if (expandable.length > 1) violations.push(`round ${round}: unnecessary parallel reasoning`);
      const next = expandable[0]!;
      parent = { label: next.label, detail: next.detail, kind: next.kind };
      depth += 1;
      lineage = [...lineage, next.label].slice(-5);
      continue;
    }

    terminal = expansion.children.some((child) => child.kind === "complete" || child.kind === "result");
    break;
  }

  for (const expected of persona.expectedTools) {
    if (!toolsChosen.includes(expected)) violations.push(`missing expected tool: ${expected}`);
  }
  for (const actual of toolsChosen) {
    if (!persona.expectedTools.includes(actual)) violations.push(`unexpected tool: ${actual}`);
  }
  if (!terminal) violations.push("did not reach a terminal result within four rounds");

  results.push({
    id: persona.id,
    persona: persona.persona,
    goal: persona.goal,
    agentPurpose: persona.agentPurpose,
    planningMs: elapsedMs,
    toolsChosen,
    expectedTools: persona.expectedTools,
    terminal,
    passed: violations.length === 0,
    violations,
    steps,
  });

  console.log(`${violations.length === 0 ? "PASS" : "FAIL"} ${persona.persona}: ${elapsedMs}ms`);
  console.log(`  tools: ${toolsChosen.join(" -> ") || "(none)"}`);
  for (const step of steps) {
    console.log(`  R${step["round"]} [${step["kind"]}] ${step["label"]}`);
  }
  for (const violation of violations) console.log(`  ! ${violation}`);
  console.log();
}

writeFileSync(
  "server/data/persona-runs.json",
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      note:
        "Multi-round planning audit with synthetic redacted tool observations. It verifies goal alignment and sequencing, not tool execution; browser/devnet runs prove execution.",
      model: process.env["LLM_MODEL"] ?? "gpt-4o-mini",
      availableTools: AVAILABLE,
      personas: results,
    },
    null,
    2,
  )}\n`,
);
console.log("saved -> server/data/persona-runs.json");
