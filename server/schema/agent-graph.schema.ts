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
    name: z.literal("get_token_price"),
    input: z.object({
      mint: z.string().trim().min(32).max(64),
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
  parent: z.object({
    label: z.string().trim().min(1).max(80),
    detail: z.string().trim().min(1).max(500),
    kind: z.union([agentGraphNodeKindSchema, z.literal("agent")]),
  }),
  depth: z.number().int().min(0).max(4),
  lineage: z.array(z.string().trim().min(1).max(80)).max(5),
  availableTools: z.array(agentGraphToolNameSchema).max(5),
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
    toolInput: z.object({
      amountTokens: z.number().optional(),
      recipient: z.string().optional(),
      reasoning: z.string().optional(),
      mint: z.string().optional(),
      inputMint: z.string().optional(),
      outputMint: z.string().optional(),
      sol: z.number().optional(),
    }).optional(),
  })).min(1).max(4),
});
