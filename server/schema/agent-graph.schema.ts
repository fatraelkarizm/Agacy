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

export const agentGraphExpansionRequestSchema = z.object({
  goal: z.string().trim().min(1).max(2_000),
  parent: z.object({
    label: z.string().trim().min(1).max(80),
    detail: z.string().trim().min(1).max(500),
    kind: z.union([agentGraphNodeKindSchema, z.literal("agent")]),
  }),
  depth: z.number().int().min(0).max(4),
  lineage: z.array(z.string().trim().min(1).max(80)).max(5),
});

export const agentGraphExpansionSchema = z.object({
  children: z.array(z.object({
    label: z.string().trim().min(1).max(54),
    detail: z.string().trim().min(1).max(220),
    kind: agentGraphNodeKindSchema,
    expand: z.boolean(),
  })).min(1).max(4),
});
