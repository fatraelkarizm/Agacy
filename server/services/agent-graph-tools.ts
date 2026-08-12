import { address, type TransactionSigner } from "@solana/kit";
import type { SolanaClient } from "../data/solana-client";
import type { SpendPolicyDTO } from "../dto/agent.dto";
import type {
  AgentGraphToolCallDTO,
  AuthorizedAgentGraphToolResultDTO,
} from "../dto/agent-graph.dto";
import { formatTokens } from "./demo-scenario";
import { runAgentOnChain } from "./agent-run";
import { evaluateSpendPolicy, fetchOnChainPolicyStatus } from "./spend-policy";

const TOKEN_SCALE = 1_000_000;

export interface ExecuteAgentGraphToolParams {
  readonly call: AgentGraphToolCallDTO;
  readonly ownerGoal: string;
  readonly client: SolanaClient;
  readonly ownerAddress: string;
  readonly policy: SpendPolicyDTO | null;
  readonly policyAccount: string | null;
  readonly agentSigner: TransactionSigner | null;
  readonly spentThisPeriod: bigint;
}

export async function executeAgentGraphTool(
  params: ExecuteAgentGraphToolParams,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  try {
    if (params.call.name === "get_wallet_overview") return walletOverview(params);
    if (params.call.name === "check_on_chain_policy") return readPolicy(params);
    return authorizeSpend(params);
  } catch (error) {
    return {
      tool: params.call.name,
      status: "failed",
      summary: error instanceof Error ? error.message : "The tool failed unexpectedly.",
      modelSummary: "The tool failed before producing a trusted result; private error detail was withheld.",
    };
  }
}

function walletOverview(params: ExecuteAgentGraphToolParams): AuthorizedAgentGraphToolResultDTO {
  const policy = params.policy;
  return {
    tool: "get_wallet_overview",
    status: "succeeded",
    summary: policy
      ? `Owner ${params.ownerAddress}. Policy: ${formatTokens(policy.maxPerTransfer)} per transfer, ${formatTokens(policy.maxPerPeriod)} per period, ${formatTokens(params.spentThisPeriod)} recorded in this session.`
      : `Owner ${params.ownerAddress}. No local spend policy is configured yet.`,
    modelSummary: policy
      ? "The owner wallet overview was read successfully. A spend policy exists; identity and monetary values were withheld from the model."
      : "The owner wallet overview was read successfully. No spend policy is configured; identity was withheld from the model.",
  };
}

async function readPolicy(
  params: ExecuteAgentGraphToolParams,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  if (!params.policyAccount) return blocked("check_on_chain_policy", "No policy account is provisioned.");
  const policy = await fetchOnChainPolicyStatus(params.client, params.policyAccount);
  if (!policy) return blocked("check_on_chain_policy", "The policy account was not found on devnet.");

  const custody = policy.custodiedTokenAccount ? "custody active" : "custody not active";
  return {
    tool: "check_on_chain_policy",
    status: "succeeded",
    summary: policy.limitsAreConfidential
      ? `Policy ${policy.policyAccount}: encrypted limits active, ${custody}.`
      : `Policy ${policy.policyAccount}: ${formatTokens(policy.maxPerTransfer)} per transfer, ${formatTokens(policy.spentInPeriod)} spent this period, ${custody}.`,
    modelSummary: `The Solana devnet policy was read successfully. ${policy.limitsAreConfidential ? "Limits are confidential" : "Public limits are active"}; ${custody}. Exact identity and monetary values were withheld from the model.`,
  };
}

async function authorizeSpend(
  params: ExecuteAgentGraphToolParams,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  if (!params.policy || !params.policyAccount) {
    return blocked("authorize_policy_spend", "Create an agent policy before requesting authorization.");
  }
  const recipientAuthorized = params.ownerGoal.includes(params.call.input.recipient) ||
    params.policy.allowedRecipients.includes(params.call.input.recipient);
  if (!recipientAuthorized || !mentionsAmount(params.ownerGoal, params.call.input.amountTokens)) {
    return blocked(
      "authorize_policy_spend",
      "The owner mandate must explicitly identify the amount and must name the recipient unless that recipient is already on the policy allow-list.",
    );
  }
  if (!params.agentSigner) {
    return blocked(
      "authorize_policy_spend",
      "The session signing key is unavailable. Recreate the agent in this tab to restore autonomous signing.",
    );
  }

  const amount = BigInt(Math.round(params.call.input.amountTokens * TOKEN_SCALE));
  const onChainPolicy = await fetchOnChainPolicyStatus(params.client, params.policyAccount);
  if (!onChainPolicy) return blocked("authorize_policy_spend", "The policy account was not found on devnet.");

  const verdict = evaluateSpendPolicy(
    {
      action: "transfer",
      reasoning: params.call.input.reasoning,
      proposedAmount: amount,
      recipient: params.call.input.recipient,
    },
    {
      policy: params.policy,
      spentThisPeriod: onChainPolicy.spentInPeriod,
      availableBalance: params.policy.maxPerPeriod,
    },
  );
  if (!verdict.compliant) {
    return {
      tool: "authorize_policy_spend",
      status: "refused",
      summary: verdict.reason,
      modelSummary: "The requested spend was refused by the owner's policy. Private values and recipient identity were withheld from the model.",
    };
  }

  let result: AuthorizedAgentGraphToolResultDTO | undefined;
  await runAgentOnChain({
    client: params.client,
    policyAccount: address(params.policyAccount),
    agentSigner: params.agentSigner,
    goal: "Authorize one owner-command spend against the deployed policy.",
    tasks: [{
      label: "Owner-command authorization",
      reasoning: params.call.input.reasoning,
      amount,
      recipient: params.call.input.recipient,
    }],
    onStep: ({ outcome }) => {
      result = outcome.status === "authorized"
        ? {
            tool: "authorize_policy_spend",
            status: "succeeded",
            summary: `Policy authorization confirmed on Solana devnet. No tokens were transferred. Signature: ${outcome.signature}`,
            modelSummary: "The deployed Solana policy authorized the requested spend. This was authorization only; no tokens were transferred. Private values, recipient, and signature were withheld from the model.",
            signature: outcome.signature,
          }
        : {
            tool: "authorize_policy_spend",
            status: "refused",
            summary: outcome.reason,
            modelSummary: "The deployed Solana policy refused the requested spend. Private values and recipient identity were withheld from the model.",
          };
    },
  });

  return result ?? {
    tool: "authorize_policy_spend",
    status: "failed",
    summary: "The policy program returned no outcome.",
    modelSummary: "The authorization tool ended without a trusted result.",
  };
}

function mentionsAmount(goal: string, amount: number): boolean {
  return (goal.match(/\d+(?:[.,]\d+)?/g) ?? []).some((value) =>
    Math.abs(Number(value.replace(",", ".")) - amount) < Number.EPSILON);
}

function blocked(
  tool: AgentGraphToolCallDTO["name"],
  summary: string,
): AuthorizedAgentGraphToolResultDTO {
  return {
    tool,
    status: "blocked",
    summary,
    modelSummary: "The requested tool is unavailable in the current owner session.",
  };
}
