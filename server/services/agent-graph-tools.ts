import type { TransactionSigner } from "@solana/kit";
import type { SolanaClient } from "../data/solana-client";
import type { SpendPolicyDTO } from "../dto/agent.dto";
import type {
  AgentGraphToolCallDTO,
  AuthorizedAgentGraphToolResultDTO,
} from "../dto/agent-graph.dto";
import {
  createGraphActions,
  type GraphActionContext,
  type UnusedAgent,
} from "../../agent/graph-actions";

/**
 * Executes one tool call from the Agent Graph.
 *
 * The tools themselves are Solana Agent Kit `Action` objects defined in
 * `agent/graph-actions.ts`; this module only resolves a call to an action and
 * runs it. Keeping dispatch here rather than in the arena component means the
 * browser never needs Agent Kit's runtime — see that file's header for why the
 * split exists.
 */

export interface ExecuteAgentGraphToolParams {
  readonly call: AgentGraphToolCallDTO;
  readonly ownerGoal: string;
  readonly client: SolanaClient;
  readonly ownerAddress: string;
  readonly policy: SpendPolicyDTO | null;
  readonly policyAccount: string | null;
  readonly agentSigner: TransactionSigner | null;
  readonly spentThisPeriod: bigint;
  readonly executeConfidentialPayment?: GraphActionContext["executeConfidentialPayment"];
  readonly paymentRecipient?: string;
}

/**
 * Agent Kit hands every handler the agent instance. These handlers never touch
 * it (dependencies arrive through `GraphActionContext` instead), so the graph
 * passes nothing — asserted at the one call site rather than weakening the
 * shared `Action` type for every other consumer.
 */
const NO_AGENT = undefined as unknown as UnusedAgent;

export async function executeAgentGraphTool(
  params: ExecuteAgentGraphToolParams,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  const action = createGraphActions({
    client: params.client,
    ownerAddress: params.ownerAddress,
    policy: params.policy,
    policyAccount: params.policyAccount,
    agentSigner: params.agentSigner,
    spentThisPeriod: params.spentThisPeriod,
    ownerGoal: params.ownerGoal,
    executeConfidentialPayment: params.executeConfidentialPayment,
    paymentRecipient: params.paymentRecipient,
  }).find((candidate) => candidate.name === params.call.name);

  if (!action) {
    return {
      tool: params.call.name,
      status: "blocked",
      summary: "Unrecognised tool call.",
      modelSummary: "The requested tool is unavailable in the current owner session.",
    };
  }

  try {
    return (await action.handler(NO_AGENT, params.call.input)) as AuthorizedAgentGraphToolResultDTO;
  } catch (error) {
    return {
      tool: params.call.name,
      status: "failed",
      summary: error instanceof Error ? error.message : "The tool failed unexpectedly.",
      modelSummary: "The tool failed before producing a trusted result; private error detail was withheld.",
    };
  }
}
