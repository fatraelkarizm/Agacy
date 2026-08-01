export type AgentAction = "transfer" | "hold" | "reject";

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
