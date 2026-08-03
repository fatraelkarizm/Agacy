export type AgentAction = "transfer" | "hold" | "reject";

export type AgentPurpose = "subscriptions" | "trading" | "procurement" | "custom";

export type AgentVisibility = "confidential" | "public";

export type AgentOnboardingStep = "define" | "policy" | "privacy" | "review";

export interface AgentDraftDTO {
  readonly name: string;
  readonly purpose: AgentPurpose;
  /** Max per single transfer, in whole tokens as typed by the owner. */
  readonly maxPerTransfer: number;
  /** Max across the whole period, in whole tokens. */
  readonly maxPerPeriod: number;
  readonly periodDays: number;
  readonly allowedRecipients: readonly string[];
  readonly visibility: AgentVisibility;
}

export interface AgentDraftValidationIssueDTO {
  readonly field: keyof AgentDraftDTO;
  readonly message: string;
}

export interface PolicyInitParamsDTO {
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
  readonly allowNonConfidentialCredits: boolean;
}

/** An agent's proposed action, before the service layer decides whether to execute it. */
export interface AgentDecisionDTO {
  readonly action: AgentAction;
  readonly reasoning: string;
  /** Present only when action is "transfer". Base units of the token. */
  readonly proposedAmount?: bigint;
  readonly recipient?: string;
}

/** Result of checking a decision against the owner's spend policy. */
export interface PolicyVerdictDTO {
  readonly compliant: boolean;
  /** Why it failed, in plain language. Empty when compliant. */
  readonly reason: string;
}

/** Owner-configured limits the agent operates under. */
export interface SpendPolicyDTO {
  /** Max base units per single transfer. */
  readonly maxPerTransfer: bigint;
  /** Max base units across all transfers in the current period. */
  readonly maxPerPeriod: bigint;
  /** Recipients the agent is allowed to send to. Empty means "any". */
  readonly allowedRecipients: readonly string[];
}

/** One payment emitted by the local agent run before it is mapped to transaction views. */
export interface AgentExecutionDTO {
  readonly amount: bigint;
  readonly recipient: string;
  readonly reasoning: string;
}

/**
 * What the Policies dashboard view is allowed to render about a live
 * on-chain policy account. Distinct from `SpendPolicyDTO` (the owner's local
 * draft) on purpose — this DTO only exists once a real account has been
 * fetched from devnet, so its presence in the UI is itself the signal that
 * "this is real, not local demo state."
 */
export interface OnChainPolicyStatusDTO {
  readonly policyAccount: string;
  readonly owner: string;
  readonly agent: string;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
  readonly spentInPeriod: bigint;
  /** Unix seconds the current period started. */
  readonly periodStart: bigint;
  /**
   * The token account the policy program owns outright, or `null` when the
   * owner still holds it themselves. This is the difference between a limit
   * the agent must route through and one it could route around, so it is
   * surfaced rather than left implicit.
   */
  readonly custodiedTokenAccount: string | null;
}
