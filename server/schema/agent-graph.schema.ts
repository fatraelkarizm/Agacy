import { z } from "zod";

export const agentGraphNodeKindSchema = z.enum([
  "observe",
  "reason",
  "tool",
  "policy",
  "result",
  "complete",
  "blocked",
]);

export const agentGraphToolNameSchema = z.enum([
  "get_wallet_overview",
  "check_on_chain_policy",
  "authorize_policy_spend",
  "get_token_price",
  "get_swap_quote",
  "cross_check_token_price",
  "research_counterparty",
  "pay_confidentially",
]);

export const agentGraphToolCallSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.enum(["get_wallet_overview", "check_on_chain_policy"]),
    input: z.object({}).strict(),
  }),
  z.object({
    name: z.literal("authorize_policy_spend"),
    input: z.object({
      amountTokens: z.number().positive().max(1_000_000_000),
      recipient: z.string().trim().min(32).max(64),
      reasoning: z.string().trim().min(1).max(220),
    }),
  }),
  z.object({
    name: z.enum(["get_token_price", "cross_check_token_price"]),
    input: z.object({
      mint: z.string().trim().min(32).max(64),
    }),
  }),
  z.object({
    name: z.literal("research_counterparty"),
    input: z.object({
      query: z.string().trim().min(1).max(200),
    }),
  }),
  z.object({
    name: z.literal("pay_confidentially"),
    input: z.object({
      amountTokens: z.number().positive().max(5),
      // Present so the arena can stamp the owner's choice onto the call. The
      // model never sets it — see the override in AgentGraphArena.
      mode: z.enum(["confidential", "public"]).optional(),
    }),
  }),
  z.object({
    name: z.literal("get_swap_quote"),
    input: z.object({
      inputMint: z.string().trim().min(32).max(64),
      outputMint: z.string().trim().min(32).max(64),
      sol: z.number().positive().max(1_000_000),
    }),
  }),
]);

export const agentGraphExpansionRequestSchema = z.object({
  goal: z.string().trim().min(1).max(2_000),
  agentPurpose: z.enum(["subscriptions", "trading", "procurement", "custom"]).optional(),
  parent: z.object({
    label: z.string().trim().min(1).max(80),
    detail: z.string().trim().min(1).max(2_000).transform((value) => value.slice(0, 500)),
    kind: z.union([agentGraphNodeKindSchema, z.literal("agent")]),
  }),
  depth: z.number().int().min(0).max(4),
  lineage: z.array(z.string().trim().min(1).max(80)).max(5),
  availableTools: z.array(agentGraphToolNameSchema).max(8),
  /**
   * Tools that already ran in this session. Sent so the model can be told they
   * are done rather than left to infer it from their silent absence.
   */
  completedTools: z.array(agentGraphToolNameSchema).max(8).optional(),
  // Bounded so a long run cannot grow the prompt without limit; the client
  // sends the most recent entries and drops older ones.
  observations: z.array(z.string().trim().min(1).max(400)).max(12).optional(),
});

export const agentGraphExpansionSchema = z.object({
  children: z.array(z.object({
    label: z.string().trim().min(1).max(54),
    detail: z.string().trim().min(1).max(220),
    kind: agentGraphNodeKindSchema,
    expand: z.boolean(),
    toolCall: agentGraphToolCallSchema.optional(),
  })).min(1).max(4),
});

/** Flat wire shape for providers that do not reliably support nested JSON-schema unions. */
export const agentGraphModelExpansionSchema = z.object({
  children: z.array(z.object({
    label: z.string(),
    detail: z.string(),
    kind: agentGraphNodeKindSchema,
    expand: z.boolean(),
    toolName: agentGraphToolNameSchema.optional(),
    /*
      The union of every tool's input fields, flattened.

      This has to be kept in step with `agentGraphToolCallSchema` by hand, and a
      missing field fails in a way that points at the wrong thing: structured
      output has nowhere to put the value, so the call arrives with no input,
      `agentGraphToolCallSchema` rejects it, and `normalizeExpansion` reports
      "the required tool is not available in this owner session" for a tool that
      is available and was correctly chosen. Adding a tool means adding its
      fields here.
    */
    toolInput: z.object({
      amountTokens: z.number().optional(),
      recipient: z.string().optional(),
      reasoning: z.string().optional(),
      mint: z.string().optional(),
      inputMint: z.string().optional(),
      outputMint: z.string().optional(),
      sol: z.number().optional(),
      query: z.string().optional(),
    }).optional(),
  })).min(1).max(4),
});
