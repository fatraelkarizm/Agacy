import { fetchPolicyAccount } from "../data/policy-program";
import type { SolanaClient } from "../data/solana-client";
import { address } from "@solana/kit";
import type {
  AgentDecisionDTO,
  OnChainPolicyStatusDTO,
  PolicyVerdictDTO,
  SpendPolicyDTO,
} from "../dto/agent.dto";

/**
 * Spend policy evaluation.
 *
 * This is the "is the agent allowed to do this" decision, deliberately kept
 * out of the data layer: the data layer's job is to move bytes to and from the
 * chain, not to hold opinions about whether a transfer should happen.
 *
 * Important limitation to be honest about: enforcing policy *here* only binds
 * an agent that goes through this server. A compromised agent holding the
 * token account's authority could call Token-2022 directly and bypass it
 * entirely — the same "it's only a polite request" weakness that makes
 * prompt-based spending limits security theater. Making the limit genuinely
 * unbypassable requires the on-chain program (see docs/ARCHITECTURE.md); this
 * module is the off-chain half that gives fast feedback and readable reasons.
 */

export interface PolicyContext {
  readonly policy: SpendPolicyDTO;
  /** Total already spent in the current period, in base units. */
  readonly spentThisPeriod: bigint;
  /** Confidential balance currently available to spend, in base units. */
  readonly availableBalance: bigint;
}

export function evaluateSpendPolicy(
  decision: AgentDecisionDTO,
  context: PolicyContext,
): PolicyVerdictDTO {
  if (decision.action !== "transfer") {
    return { compliant: true, reason: "" };
  }

  const amount = decision.proposedAmount;
  if (amount === undefined) {
    return { compliant: false, reason: "Transfer decision is missing an amount." };
  }
  if (amount <= 0n) {
    return { compliant: false, reason: "Transfer amount must be greater than zero." };
  }

  const { policy, spentThisPeriod, availableBalance } = context;

  if (amount > policy.maxPerTransfer) {
    return {
      compliant: false,
      reason: `Transfer of ${amount} exceeds the per-transfer limit of ${policy.maxPerTransfer}.`,
    };
  }

  if (spentThisPeriod + amount > policy.maxPerPeriod) {
    const remaining = policy.maxPerPeriod - spentThisPeriod;
    return {
      compliant: false,
      reason: `Transfer of ${amount} would exceed the period limit; only ${remaining < 0n ? 0n : remaining} remains.`,
    };
  }

  if (amount > availableBalance) {
    return {
      compliant: false,
      reason: `Transfer of ${amount} exceeds the available balance of ${availableBalance}.`,
    };
  }

  const recipient = decision.recipient;
  if (policy.allowedRecipients.length > 0) {
    if (recipient === undefined) {
      return { compliant: false, reason: "Transfer decision is missing a recipient." };
    }
    if (!policy.allowedRecipients.includes(recipient)) {
      return { compliant: false, reason: `Recipient ${recipient} is not on the allow-list.` };
    }
  }

  return { compliant: true, reason: "" };
}

/**
 * Read the real state of a provisioned policy account, for the Policies
 * dashboard view. Returns `null` when the account doesn't exist yet (not
 * provisioned) rather than throwing — that's an expected state, not an error.
 */
export async function fetchOnChainPolicyStatus(
  client: SolanaClient,
  policyAccount: string,
): Promise<OnChainPolicyStatusDTO | null> {
  const state = await fetchPolicyAccount(client, address(policyAccount));
  if (!state) return null;

  return {
    policyAccount,
    owner: state.owner,
    agent: state.agent,
    maxPerTransfer: state.maxPerTransfer,
    maxPerPeriod: state.maxPerPeriod,
    periodSeconds: state.periodSeconds,
    spentInPeriod: state.spentInPeriod,
    periodStart: state.periodStart,
  };
}
