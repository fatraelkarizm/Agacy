import type { AgentDecisionDTO, PolicyVerdictDTO, SpendPolicyDTO } from "../../server/dto/agent.dto.js";
import type { AuthorizedTransactionDTO } from "../../server/dto/transaction.dto.js";
import { evaluateSpendPolicy, type PolicyContext } from "../../server/services/spend-policy.js";

/**
 * The agent's only route to moving money.
 *
 * The agent proposes; this tool disposes. The separation matters: an LLM can be
 * talked into proposing anything — via prompt injection, a poisoned tool result,
 * or plain hallucination — so the decision to *execute* has to live outside the
 * model's reach. Every proposal is checked against the spend policy here, and a
 * rejection is returned to the agent as an observation rather than thrown, so
 * the agent can reason about the refusal instead of crashing on it.
 */

export interface TransferExecutor {
  (decision: AgentDecisionDTO): Promise<AuthorizedTransactionDTO>;
}

export interface ConfidentialTransferToolDeps {
  readonly policy: SpendPolicyDTO;
  readonly getContext: () => Promise<Omit<PolicyContext, "policy">>;
  readonly execute: TransferExecutor;
}

export type ToolResult =
  | { readonly ok: true; readonly transaction: AuthorizedTransactionDTO }
  | { readonly ok: false; readonly refusal: string };

export function createConfidentialTransferTool(deps: ConfidentialTransferToolDeps) {
  return {
    name: "confidential_transfer",
    description:
      "Send tokens confidentially. The amount and resulting balance are encrypted on-chain. " +
      "Subject to the owner's spend policy — requests outside the policy are refused.",

    async run(decision: AgentDecisionDTO): Promise<ToolResult> {
      const context = await deps.getContext();
      const verdict: PolicyVerdictDTO = evaluateSpendPolicy(decision, {
        policy: deps.policy,
        ...context,
      });

      if (!verdict.compliant) {
        return { ok: false, refusal: verdict.reason };
      }
      if (decision.action !== "transfer") {
        return { ok: false, refusal: `No transfer to perform for action "${decision.action}".` };
      }

      const transaction = await deps.execute(decision);
      return { ok: true, transaction };
    },
  };
}
