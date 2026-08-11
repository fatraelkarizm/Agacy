import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, NoObjectGeneratedError } from "ai";
import type {
  AgentGraphExpansionDTO,
  AgentGraphExpansionRequestDTO,
} from "../dto/agent-graph.dto";
import { agentGraphExpansionSchema } from "../schema/agent-graph.schema";

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
      schema: agentGraphExpansionSchema,
      temperature: 0.25,
      system: [
        "You expand one node in a generic autonomous-agent execution graph.",
        "Break the current node into the smallest useful next observations, reasoning steps, tool calls, policy checks, or results.",
        "Return 2-4 children. At most two children may have expand=true.",
        finalDepth
          ? "This is the final depth. Every child must have expand=false and end as complete, blocked, or a factual result."
          : "Set expand=true only when that child genuinely needs more work.",
        "Never claim an external action happened unless the lineage includes a real tool result proving it.",
        "If the goal needs a capability that is not present, emit a blocked node naming the missing capability.",
        "Keep labels short and details factual. Do not expose hidden chain-of-thought; provide concise action summaries only.",
      ].join("\n"),
      prompt: JSON.stringify({
        ownerGoal: input.goal,
        currentNode: input.parent,
        lineage: input.lineage,
        depth: input.depth,
        availableCapabilities: [
          "reason about the supplied goal",
          "inspect the Agacy session and policy",
          "propose a policy-gated Solana action",
          "request installed tools",
        ],
      }),
    });

    return result.object;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text) {
      const recovered = recoverExpansion(error.text, finalDepth);
      if (recovered) return recovered;
    }
    throw error;
  }
}

function recoverExpansion(text: string, finalDepth: boolean): AgentGraphExpansionDTO | null {
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
      return [{
        label: cleanText(value["label"], 54),
        detail: cleanText(value["detail"], 220),
        kind,
        expand,
      }];
    });

    const parsed = agentGraphExpansionSchema.safeParse({ children });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
