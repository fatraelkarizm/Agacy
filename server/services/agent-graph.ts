import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, NoObjectGeneratedError } from "ai";
import type {
  AgentGraphChildDTO,
  AgentGraphExpansionDTO,
  AgentGraphExpansionRequestDTO,
  AgentGraphToolName,
} from "../dto/agent-graph.dto";
import {
  agentGraphExpansionSchema,
  agentGraphModelExpansionSchema,
  agentGraphToolCallSchema,
} from "../schema/agent-graph.schema";
import { GRAPH_ACTION_DESCRIPTIONS } from "../../agent/graph-actions";

const DEFAULT_MODEL = "gpt-4o-mini";
const NODE_KINDS = new Set([
  "observe",
  "reason",
  "tool",
  "policy",
  "result",
  "complete",
  "blocked",
]);
/**
 * Descriptions come from the Agent Kit action registry rather than a copy kept
 * here, so what the model is told a tool does cannot drift from what the tool
 * actually implements. They are deliberately *not* shared with
 * `agent/tools/toolkit.ts`: the CLI's `get_wallet_overview` reports cluster and
 * SOL balance while the graph's reports owner and policy, so reusing that
 * wording would describe fields this path never returns. The coverage test in
 * tests/unit/services/agent-graph-coverage.test.ts is what keeps the two
 * toolsets from silently diverging in membership.
 */
const TOOL_DESCRIPTIONS: Record<AgentGraphToolName, string> = GRAPH_ACTION_DESCRIPTIONS;

/**
 * Toolkit tools the graph deliberately does not expose, with the reason.
 *
 * The graph runs in the browser against a session-scoped agent key, so anything
 * needing a funded server-side payer, a provisioned confidential mint, or real
 * mainnet funds cannot be driven from here.
 */
export const GRAPH_EXCLUDED_TOOLKIT_TOOLS: Record<string, string> = {
  pay_vendor_confidentially:
    "Needs a provisioned confidential mint, funded payer, and recipient ElGamal keys that only the devnet scripts set up.",
  request_devnet_airdrop:
    "Funds the CLI run's own payer keypair; the browser session has no such keypair to top up.",
  swap_tokens:
    "Executes a real mainnet swap. Deliberately unreachable from the browser demo — quoting is exposed instead.",
};

/** Graph-only tools with no toolkit equivalent, with the reason. */
export const GRAPH_ONLY_TOOLS: Record<string, string> = {
  authorize_policy_spend:
    "Signs an authorize against the deployed policy program using the browser session's agent key, which the CLI toolkit has no concept of.",
  cross_check_token_price:
    "Reaches AIsa through this app's own /api/aisa/price route, which holds the Bearer key server-side. The CLI toolkit has no Next.js route to call and would need the credential handed to it directly.",
  research_counterparty:
    "Reaches AIsa's web search through this app's own /api/aisa/research route, for the same credential reason as cross_check_token_price.",
  pay_confidentially:
    "Runs through this app's own /api/agent/confidential-payment route, which holds the funded devnet payer and the provisioned confidential mint. The browser session has neither — the same constraint that keeps pay_vendor_confidentially CLI-only above.",
};

export async function expandAgentGraph(
  input: AgentGraphExpansionRequestDTO,
): Promise<AgentGraphExpansionDTO> {
  const apiKey = process.env["LLM_API_KEY"];
  if (!apiKey) throw new Error("LLM_API_KEY is not configured");

  const openai = createOpenAI({
    apiKey,
    ...(process.env["BASE_URL"] ? { baseURL: process.env["BASE_URL"] } : {}),
  });
  const finalDepth = input.depth >= 3;
  try {
    const result = await generateObject({
      model: openai(process.env["LLM_MODEL"] ?? DEFAULT_MODEL),
      schema: agentGraphModelExpansionSchema,
      temperature: 0.25,
      maxTokens: 1_200,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(30_000),
      system: [
        "You expand one node in a generic autonomous-agent execution graph.",
        "Break the current node into the smallest useful next observations, reasoning steps, tool calls, policy checks, or results.",
        "Return 2-4 children. At most two children may have expand=true.",
        finalDepth
          ? "This is the final depth. Every child must have expand=false and end as complete, blocked, or a factual result."
          : "Set expand=true only when that child genuinely needs more work.",
        "Never claim an external action happened unless the lineage includes a real tool result proving it.",
        "When a listed tool is needed, emit kind=tool with its exact toolName and toolInput, then set expand=false. The runtime will validate and execute it before adding a factual result node.",
        "Never invent a toolName. authorize_policy_spend is not a token transfer and must never be described as payment completion.",
        // Without this the model narrates the payment instead of making it: it
        // emits a reason node saying "proceed with the confidential payment"
        // and the run ends having moved nothing.
        "When the owner asks to pay, send, settle, or renew something confidentially and pay_confidentially is available, emit kind=tool with toolName=pay_confidentially and the amount from the goal. Do not describe the payment in a reason node instead of calling the tool — a step that says a payment will happen is not a payment.",
        "Only call authorize_policy_spend when the owner goal explicitly supplies the amount and recipient; never invent either value.",
        "For goals about buying, pricing, or swapping a token, use get_token_price and get_swap_quote when they are available — they return real market data and let you make concrete progress instead of blocking immediately. Both are read-only research: they never execute a purchase.",
        "A fixed invoice, subscription, payout, or keeper reward does not need token-price research unless the owner explicitly asks for pricing or conversion. Do not invent a price-check step merely because the amount is described as tokens, and do not create a refusal for a mint address the task never needed.",
        "get_swap_quote requires a real base58 mint address for inputMint and outputMint (32-44 characters), never a ticker symbol like 'X' or 'BONK'. If the goal only names a token by symbol and does not supply its mint address, do not call get_swap_quote — emit a blocked node asking for the mint address instead of guessing one.",
        "Swap execution itself is mainnet-only and out of scope for this session even when get_swap_quote is available — after quoting, end with a blocked or complete node that honestly says execution requires a mainnet run (npm run agent:mainnet), not a plain unexplained refusal.",
        "When currentNode contains verified tool observations, treat those reads as complete. Continue reasoning from the observation; do not request the same tool again or mark the completed read as unavailable.",
        "When a sibling tool call is fetching a fact, do not also emit a blocked child for that missing fact. Let the runtime execute the tool and continue from its verified observation.",
        "verifiedObservations lists everything this run has already established, including results from other branches. Treat every entry as settled fact: build on it, never re-request a tool that produced one, and never contradict or re-ask for something already answered there.",
        // Without this the model re-requests a tool it already used, that
        // request is normalised into a red "not available" node, and a run whose
        // payment actually succeeded ends looking like a failure.
        ...(input.completedTools?.length
          ? [
              `These tools have ALREADY RUN successfully in this session and are finished: ${input.completedTools.join(", ")}. Their results are in verifiedObservations. Do not request them again — treat the work as done and move on to reporting or the next step.`,
            ]
          : []),
        "If the goal needs a capability that is not present at all in availableTools, emit a blocked node naming the missing capability.",
        "Keep labels short and details factual. Do not expose hidden chain-of-thought; provide concise action summaries only.",
      ].join("\n"),
      prompt: JSON.stringify({
        ownerGoal: input.goal,
        currentNode: input.parent,
        lineage: input.lineage,
        depth: input.depth,
        verifiedObservations: input.observations ?? [],
        availableTools: input.availableTools.map((name) => ({
          name,
          description: TOOL_DESCRIPTIONS[name],
        })),
      }),
    });

    return normalizeExpansion(
      toExpansion(result.object.children),
      finalDepth,
      input.availableTools,
      input.completedTools ?? [],
    );
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text) {
      const recovered = recoverExpansion(error.text, finalDepth, input.availableTools);
      if (recovered) return recovered;
    }
    throw error;
  }
}

function recoverExpansion(
  text: string,
  finalDepth: boolean,
  availableTools: readonly AgentGraphToolName[],
): AgentGraphExpansionDTO | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw["children"])) return null;

    let expandable = 0;
    const children = raw["children"].slice(0, 4).flatMap((value) => {
      if (!isRecord(value) || typeof value["label"] !== "string" || typeof value["detail"] !== "string") {
        return [];
      }
      const kind = typeof value["kind"] === "string" && NODE_KINDS.has(value["kind"])
        ? value["kind"]
        : "reason";
      const expand = !finalDepth && value["expand"] === true && expandable < 2;
      if (expand) expandable += 1;
      const toolCall = parseToolCall(value);
      return [{
        label: cleanText(value["label"], 54),
        detail: cleanText(value["detail"], 220),
        kind,
        expand,
        ...(toolCall.success ? { toolCall: toolCall.data } : {}),
      }];
    });

    const parsed = agentGraphExpansionSchema.safeParse({ children });
    return parsed.success ? normalizeExpansion(parsed.data, finalDepth, availableTools) : null;
  } catch {
    return null;
  }
}

function toExpansion(
  children: ReadonlyArray<{
    readonly label: string;
    readonly detail: string;
    readonly kind: AgentGraphChildDTO["kind"];
    readonly expand: boolean;
    readonly toolName?: AgentGraphToolName;
    readonly toolInput?: Record<string, unknown>;
  }>,
): AgentGraphExpansionDTO {
  return {
    children: children.map((child) => {
      const toolCall = agentGraphToolCallSchema.safeParse({
        name: child.toolName,
        input: child.toolInput ?? {},
      });
      return {
        label: cleanText(child.label, 54),
        detail: cleanText(child.detail, 220),
        kind: child.kind,
        expand: child.expand,
        ...(toolCall.success ? { toolCall: toolCall.data } : {}),
      };
    }),
  };
}

function parseToolCall(value: Record<string, unknown>) {
  const nested = agentGraphToolCallSchema.safeParse(value["toolCall"]);
  if (nested.success) return nested;
  return agentGraphToolCallSchema.safeParse({
    name: value["toolName"],
    input: isRecord(value["toolInput"]) ? value["toolInput"] : {},
  });
}

function normalizeExpansion(
  expansion: AgentGraphExpansionDTO,
  finalDepth: boolean,
  availableTools: readonly AgentGraphToolName[],
  completedTools: readonly AgentGraphToolName[] = [],
): AgentGraphExpansionDTO {
  let expandable = 0;
  return {
    children: expansion.children.map((child): AgentGraphChildDTO => {
      if (child.kind === "tool") {
        if (!child.toolCall || !availableTools.includes(child.toolCall.name)) {
          // A tool that already ran is a finished step, not a missing
          // capability. Reporting both as "unavailable" ended an otherwise
          // successful run on a red refusal node, which read as failure.
          const alreadyDone =
            child.toolCall !== undefined && completedTools.includes(child.toolCall.name);
          return {
            label: child.label,
            detail: alreadyDone
              ? "Already completed earlier in this session. Its result is in the verified observations."
              : "The required tool is not available in this owner session.",
            kind: alreadyDone ? "complete" : "blocked",
            expand: false,
          };
        }
        return { ...child, expand: false };
      }
      const expand = !finalDepth && child.expand && expandable < 2;
      if (expand) expandable += 1;
      return { ...child, expand, toolCall: undefined };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
