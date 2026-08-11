export type AgentRunEventKind =
  | "goal"
  | "observe"
  | "decide"
  | "policy"
  | "execute"
  | "refused";

export type AgentRunEventStatus =
  | "queued"
  | "running"
  | "completed"
  | "approved"
  | "confirmed"
  | "rejected";

/** Safe for an unauthorised observer: no goal, amount, recipient, or reasoning. */
export interface PublicAgentRunEventDTO {
  readonly id: string;
  readonly taskIndex: number;
  readonly kind: AgentRunEventKind;
  readonly status: AgentRunEventStatus;
  readonly signature?: string;
}

/** Owner-only execution detail. Never pass this DTO to the public graph. */
export interface AuthorizedAgentRunEventDTO extends PublicAgentRunEventDTO {
  readonly taskLabel?: string;
  readonly detail: string;
  readonly amount?: bigint;
  readonly recipient?: string;
}

export interface AgentRunGraphEventDTO {
  readonly public: PublicAgentRunEventDTO;
  readonly authorized: AuthorizedAgentRunEventDTO;
}

export interface AgentRunTaskDTO {
  readonly label: string;
  readonly reasoning: string;
  readonly amount: bigint;
  readonly recipient: string;
}

export type AgentRunOutcomeDTO =
  | { readonly status: "authorized"; readonly signature: string }
  | { readonly status: "refused"; readonly reason: string };

export interface AgentRunStepDTO {
  readonly task: AgentRunTaskDTO;
  readonly outcome: AgentRunOutcomeDTO;
}
