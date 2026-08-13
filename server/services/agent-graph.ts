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
const TOOL_DESCRIPTIONS: Record<AgentGraphToolName, string> = {
  get_wallet_overview:
    "Read the connected owner's local Agacy wallet and policy overview. Input must be {}. Read-only.",
  check_on_chain_policy:
    "Read the provisioned policy account from Solana devnet. Input must be {}. Read-only.",
  authorize_policy_spend:
    "Ask the deployed policy program to authorize a spend on devnet. Input: amountTokens, recipient, reasoning. This proves policy authorization only; it does not transfer tokens.",
  get_token_price:
    "Look up a token's real USD market price via Jupiter. Input: mint (token mint address). Read-only, no wallet needed.",
  get_swap_quote:
    "Get a real routed swap quote from Jupiter (mainnet market data, safe to call from any cluster). Input: inputMint, outputMint, sol (input amount). Read-only — does not execute anything.",
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
        "Only call authorize_policy_spend when the owner goal explicitly supplies the amount and recipient; never invent either value.",
        "For goals about buying, pricing, or swapping a token, use get_token_price and get_swap_quote when they are available — they return real market data and let you make concrete progress instead of blocking immediately. Both are read-only research: they never execute a purchase.",
        "get_swap_quote requires a real base58 mint address for inputMint and outputMint (32-44 characters), never a ticker symbol like 'X' or 'BONK'. If the goal only names a token by symbol and does not supply its mint address, do not call get_swap_quote — emit a blocked node asking for the mint address instead of guessing one.",
        "Swap execution itself is mainnet-only and out of scope for this session even when get_swap_quote is available — after quoting, end with a blocked or complete node that honestly says execution requires a mainnet run (npm run agent:mainnet), not a plain unexplained refusal.",
        "When currentNode contains verified tool observations, treat those reads as complete. Continue reasoning from the observation; do not request the same tool again or mark the completed read as unavailable.",
        "If the goal needs a capability that is not present at all in availableTools, emit a blocked node naming the missing capability.",
        "Keep labels short and details factual. Do not expose hidden chain-of-thought; provide concise action summaries only.",
      ].join("\n"),
      prompt: JSON.stringify({
        ownerGoal: input.goal,
        currentNode: input.parent,
        lineage: input.lineage,
        depth: input.depth,
        availableCapabilities: ["reason about the supplied goal"],
        availableTools: input.availableTools.map((name) => ({
          name,
          description: TOOL_DESCRIPTIONS[name],
        })),
      }),
    });

    return normalizeExpansion(toExpansion(result.object.children), finalDepth, input.availableTools);
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
): AgentGraphExpansionDTO {
  let expandable = 0;
  return {
    children: expansion.children.map((child): AgentGraphChildDTO => {
      if (child.kind === "tool") {
        if (!child.toolCall || !availableTools.includes(child.toolCall.name)) {
          return {
            label: child.label,
            detail: "The required tool is not available in this owner session.",
            kind: "blocked",
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
