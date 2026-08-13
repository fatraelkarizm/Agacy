export type AgentGraphNodeKind =
  | "observe"
  | "reason"
  | "tool"
  | "policy"
  | "result"
  | "complete"
  | "blocked";

export type AgentGraphToolName =
  | "get_wallet_overview"
  | "check_on_chain_policy"
  | "authorize_policy_spend"
  | "get_token_price"
  | "get_swap_quote"
  | "cross_check_token_price"
  | "research_counterparty"
  | "pay_confidentially";

export type AgentGraphToolCallDTO =
  | {
      readonly name: "get_wallet_overview" | "check_on_chain_policy";
      readonly input: Record<string, never>;
    }
  | {
      readonly name: "authorize_policy_spend";
      readonly input: {
        readonly amountTokens: number;
        readonly recipient: string;
        readonly reasoning: string;
      };
    }
  | {
      readonly name: "get_token_price" | "cross_check_token_price";
      readonly input: {
        readonly mint: string;
      };
    }
  | {
      readonly name: "research_counterparty";
      readonly input: {
        readonly query: string;
      };
    }
  | {
      readonly name: "pay_confidentially";
      readonly input: {
        readonly amountTokens: number;
      };
    }
  | {
      readonly name: "get_swap_quote";
      readonly input: {
        readonly inputMint: string;
        readonly outputMint: string;
        readonly sol: number;
      };
    };

export interface AuthorizedAgentGraphToolResultDTO {
  readonly tool: AgentGraphToolName;
  readonly status: "succeeded" | "refused" | "blocked" | "failed";
  /** Owner-only detail rendered in the private canvas. */
  readonly summary: string;
  /** Redacted observation safe to send back to the model for replanning. */
  readonly modelSummary: string;
  readonly signature?: string;
}

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
  readonly availableTools: readonly AgentGraphToolName[];
  /**
   * Redacted results of every tool this run has already executed, in order.
   *
   * `lineage` only carries ancestor *labels*, so without this a branch could
   * not see what a sibling branch already established, and facts more than one
   * node back were lost entirely — the model would re-derive or contradict
   * things it had already verified. These are `modelSummary` strings, never the
   * owner-only `summary`, so accumulating them cannot widen what the model sees.
   */
  readonly observations?: readonly string[];
}

export interface AgentGraphChildDTO {
  readonly label: string;
  readonly detail: string;
  readonly kind: AgentGraphNodeKind;
  readonly expand: boolean;
  readonly toolCall?: AgentGraphToolCallDTO;
}

export interface AgentGraphExpansionDTO {
  readonly children: readonly AgentGraphChildDTO[];
}
