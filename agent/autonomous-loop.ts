import { generateText, type CoreTool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createVercelAITools, type Action, type SolanaAgentKit } from "solana-agent-kit";
import {
  guardTools,
  assertToolsDeclareSpend,
  type GuardedRun,
  type GuardedTool,
} from "./policy-guard.js";
import { buildToolkit, type AgacyTool, type ToolContext } from "./tools/toolkit.js";

/**
 * The autonomous agent loop.
 *
 * This is what separates an agent from a scripted bot: the model is given a
 * goal and a toolset, and it decides which tools to call, in what order, and
 * when it is finished. Nothing here iterates a fixed task list — the sequence
 * is the model's, and a run that solves the goal in one call is as valid as
 * one that takes six.
 *
 * The autonomy is bounded in exactly two places, both deliberate:
 *   - `maxSteps` stops a model that loops without converging (an unbounded
 *     agent with an API key attached is a billing incident waiting to happen).
 *   - Every value-moving tool is wrapped by policy-guard.ts, so "the model
 *     decided to" is never sufficient authority to move money.
 */

export interface AgentRunStep {
  readonly tool: string;
  readonly input: unknown;
  readonly outcome: "allowed" | "refused";
  readonly reason?: string;
}

export interface AutonomousRunResult {
  /** The model's closing summary of what it did. */
  readonly summary: string;
  readonly steps: readonly AgentRunStep[];
  readonly refusals: readonly string[];
  readonly spends: readonly { tool: string; amount: bigint }[];
  readonly spentThisPeriod: bigint;
  /** How many model turns were used, to make a truncated run obvious. */
  readonly stepsUsed: number;
}

export interface AutonomousRunOptions {
  readonly goal: string;
  readonly agentKit: SolanaAgentKit;
  readonly toolContext: Omit<ToolContext, "spentThisPeriod">;
  readonly initialSpentThisPeriod?: bigint;
  readonly maxSteps?: number;
  readonly model?: string;
  readonly tools?: readonly AgacyTool[];
  readonly onStep?: (step: AgentRunStep) => void;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MODEL = "gpt-4o-mini";

function systemPrompt(cluster: string, realFunds: boolean): string {
  return [
    "You are Agacy, an autonomous payments agent operating a Solana wallet on behalf of an owner.",
    "",
    "How to work:",
    "- Start by reading your situation with get_wallet_overview. Do not guess balances or limits.",
    "- Choose your own sequence of tools. Stop as soon as the goal is met.",
    "- If a tool refuses you, read the reason and adapt. Do not retry the identical call.",
    "- When you pay, put a truthful, specific reason in the reasoning field. It is encrypted",
    "  on-chain and is the owner's audit trail, so it must describe the real purpose.",
    "- Finish with a short plain-language summary of what you did and what you deliberately did not.",
    "",
    "Hard rules you cannot talk your way around:",
    "- The owner's spend policy is enforced outside you, on-chain. Requests over the limit are",
    "  refused no matter how you justify them. Do not attempt to split a payment across calls to",
    "  get around a per-transfer limit; the period limit catches that and it is dishonest.",
    "- Never invent an address. Only use addresses given to you in the goal or returned by a tool.",
    "",
    `Current cluster: ${cluster}.`,
    realFunds
      ? "REAL FUNDS ARE AT RISK on this run. Prefer the smallest action that satisfies the goal, and do not spend more than the goal requires."
      : "This is devnet. Funds are test-only, but behave exactly as you would with real money.",
  ].join("\n");
}

/**
 * Bridge guarded tools into the Agent Kit `Action` shape its adapters expect.
 * Takes GuardedTool rather than AgacyTool so an unguarded tool cannot reach an
 * adapter by accident — the type system enforces "guard first, then expose".
 */
export function toAgentKitActions(tools: readonly GuardedTool[]): Action[] {
  return tools.map((tool) => ({
    name: tool.name,
    similes: [],
    description: tool.description,
    examples: [],
    schema: tool.schema,
    handler: async (_agent: SolanaAgentKit, input: Record<string, unknown>) =>
      (await tool.execute(input)) as Record<string, unknown>,
  }));
}

export async function runAutonomousAgent(
  options: AutonomousRunOptions,
): Promise<AutonomousRunResult> {
  const apiKey = process.env["LLM_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "LLM_API_KEY is not set. The autonomous loop needs a model to reason with — " +
        "set it in .env.local alongside BASE_URL.",
    );
  }

  const baseTools = options.tools ?? buildToolkit();
  assertToolsDeclareSpend(baseTools);

  const run: GuardedRun = {
    spentThisPeriod: options.initialSpentThisPeriod ?? 0n,
    refusals: [],
    spends: [],
  };
  const steps: AgentRunStep[] = [];

  const guarded = guardTools({
    tools: baseTools,
    baseContext: options.toolContext,
    run,
    onToolCall: (event) => {
      const step: AgentRunStep = {
        tool: event.tool,
        input: event.input,
        outcome: event.outcome,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
      steps.push(step);
      options.onStep?.(step);
    },
  });

  // The guarded tools go through Agent Kit's own Vercel AI adapter rather than
  // being hand-converted, so the toolset stays usable by anything else that
  // speaks Agent Kit actions (LangChain, OpenAI, MCP) without a second bridge.
  const actions = toAgentKitActions(guarded);
  const byIndex = createVercelAITools(options.agentKit, actions) as Record<string, CoreTool>;

  // Agent Kit 2.0.10 keys its adapter output by array index
  // (`tools[index.toString()]`), and the AI SDK sends each key to the model as
  // the callable function name. Left as-is, the model chooses between tools
  // named "0".."6" and has only the description to go on — so re-key by the
  // action's real name, which is what every prompt and refusal message in this
  // codebase already calls it.
  const aiTools = Object.fromEntries(
    actions.map((action, index) => [action.name, byIndex[String(index)]]),
  ) as Record<string, CoreTool>;

  const openai = createOpenAI({
    apiKey,
    ...(process.env["BASE_URL"] ? { baseURL: process.env["BASE_URL"] } : {}),
  });

  const result = await generateText({
    model: openai(options.model ?? DEFAULT_MODEL),
    system: systemPrompt(options.toolContext.cluster, options.toolContext.cluster === "mainnet"),
    prompt: options.goal,
    tools: aiTools,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
  });

  return {
    summary: result.text,
    steps,
    refusals: run.refusals,
    spends: run.spends,
    spentThisPeriod: run.spentThisPeriod,
    stepsUsed: result.steps?.length ?? 0,
  };
}
