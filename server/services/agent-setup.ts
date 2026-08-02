import type { SpendPolicyDTO } from "../dto/agent.dto";

/**
 * Turning what an owner wants into a policy the chain can enforce.
 *
 * The point of this layer is that "how the agent should behave" is the owner's
 * decision, expressed once at setup, and from then on it is a property of the
 * account rather than an instruction the agent could be talked out of. This
 * module only translates and validates; enforcement lives in the on-chain
 * program.
 */

export type AgentPurpose = "subscriptions" | "trading" | "procurement" | "custom";

export type Visibility = "confidential" | "public";

export interface AgentDraftDTO {
  readonly name: string;
  readonly purpose: AgentPurpose;
  /** Max per single transfer, in whole tokens as typed by the owner. */
  readonly maxPerTransfer: number;
  /** Max across the whole period, in whole tokens. */
  readonly maxPerPeriod: number;
  readonly periodDays: number;
  readonly allowedRecipients: readonly string[];
  readonly visibility: Visibility;
}

export interface ValidationIssue {
  readonly field: keyof AgentDraftDTO;
  readonly message: string;
}

/** Sensible starting points per purpose, so the owner edits rather than invents. */
export const PURPOSE_PRESETS: Record<AgentPurpose, Omit<AgentDraftDTO, "name" | "purpose">> = {
  subscriptions: {
    maxPerTransfer: 20,
    maxPerPeriod: 100,
    periodDays: 30,
    allowedRecipients: [],
    visibility: "confidential",
  },
  trading: {
    maxPerTransfer: 250,
    maxPerPeriod: 1_000,
    periodDays: 7,
    allowedRecipients: [],
    visibility: "confidential",
  },
  procurement: {
    maxPerTransfer: 500,
    maxPerPeriod: 5_000,
    periodDays: 30,
    allowedRecipients: [],
    visibility: "confidential",
  },
  custom: {
    maxPerTransfer: 50,
    maxPerPeriod: 200,
    periodDays: 30,
    allowedRecipients: [],
    visibility: "confidential",
  },
};

const DECIMALS = 6;

export function validateAgentDraft(draft: AgentDraftDTO): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (draft.name.trim().length === 0) {
    issues.push({ field: "name", message: "Give the agent a name so you can tell it apart later." });
  }
  if (draft.maxPerTransfer <= 0) {
    issues.push({ field: "maxPerTransfer", message: "Per-transfer limit must be above zero." });
  }
  if (draft.maxPerPeriod <= 0) {
    issues.push({ field: "maxPerPeriod", message: "Period limit must be above zero." });
  }
  // A per-transfer cap above the period cap is not a limit — the first payment
  // would already exhaust the budget, which is almost never what was meant.
  if (draft.maxPerTransfer > draft.maxPerPeriod) {
    issues.push({
      field: "maxPerTransfer",
      message: "Per-transfer limit cannot exceed the period limit.",
    });
  }
  if (draft.periodDays < 1) {
    issues.push({ field: "periodDays", message: "Period must be at least one day." });
  }

  return issues;
}

export interface PolicyInitParams {
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
  readonly allowNonConfidentialCredits: boolean;
}

/**
 * Convert a validated draft into the exact values the on-chain program stores.
 * Whole tokens become base units here, once, rather than at every call site.
 */
export function toPolicyInitParams(draft: AgentDraftDTO): PolicyInitParams {
  const issues = validateAgentDraft(draft);
  if (issues.length > 0) {
    throw new Error(`Cannot build a policy from an invalid draft: ${issues[0]!.message}`);
  }

  return {
    maxPerTransfer: toBaseUnits(draft.maxPerTransfer),
    maxPerPeriod: toBaseUnits(draft.maxPerPeriod),
    periodSeconds: BigInt(draft.periodDays) * 86_400n,
    // Confidential is the default. Public mode exists only for agents that are
    // deliberately meant to be auditable in the open — a published trading bot,
    // a DAO-operated agent — not as an equal alternative.
    allowNonConfidentialCredits: draft.visibility === "public",
  };
}

/** The in-memory policy the off-chain checker uses, derived from the same draft. */
export function toSpendPolicy(draft: AgentDraftDTO): SpendPolicyDTO {
  const params = toPolicyInitParams(draft);
  return {
    maxPerTransfer: params.maxPerTransfer,
    maxPerPeriod: params.maxPerPeriod,
    allowedRecipients: draft.allowedRecipients,
  };
}

function toBaseUnits(wholeTokens: number): bigint {
  return BigInt(Math.round(wholeTokens * 10 ** DECIMALS));
}
