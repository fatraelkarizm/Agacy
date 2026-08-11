export type AgentGraphNodeKind =
  | "observe"
  | "reason"
  | "tool"
  | "policy"
  | "result"
  | "complete"
  | "blocked";

export interface AgentGraphParentDTO {
  readonly label: string;
  readonly detail: string;
  readonly kind: AgentGraphNodeKind | "agent";
}

export interface AgentGraphExpansionRequestDTO {
  readonly goal: string;
  readonly parent: AgentGraphParentDTO;
  readonly depth: number;
  readonly lineage: readonly string[];
}

export interface AgentGraphChildDTO {
  readonly label: string;
  readonly detail: string;
  readonly kind: AgentGraphNodeKind;
  readonly expand: boolean;
}

export interface AgentGraphExpansionDTO {
  readonly children: readonly AgentGraphChildDTO[];
}
