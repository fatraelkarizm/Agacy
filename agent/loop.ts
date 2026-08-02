import type { AgentDecisionDTO, SpendPolicyDTO } from "../server/dto/agent.dto";
import { evaluateSpendPolicy } from "../server/services/spend-policy";

/**
 * The agent reasoning loop.
 *
 * Each turn the agent observes its situation, decides what to do, and the
 * decision is checked against the owner's spend policy before anything is
 * executed. Every stage is emitted as a step so the caller (and the demo UI)
 * can show the reasoning rather than just the outcome — an agent that moves
 * money should be legible, not a black box that occasionally debits you.
 *
 * The "brain" is pluggable. A deterministic brain keeps the demo reproducible
 * and API-key-free; an LLM brain drops into the same interface for real use.
 */

export type StepKind = "observe" | "think" | "decide" | "policy" | "execute" | "refused";

export interface AgentStep {
  readonly kind: StepKind;
  readonly text: string;
  /** Present on execute steps. */
  readonly amount?: bigint;
  readonly recipient?: string;
}

export interface AgentTask {
  readonly prompt: string;
  readonly amount: bigint;
  readonly recipient: string;
  readonly recipientLabel: string;
}

export interface AgentState {
  readonly availableBalance: bigint;
  readonly spentThisPeriod: bigint;
}

/** Decides what to do about a task. Swap for an LLM-backed implementation in production. */
export interface AgentBrain {
  decide(task: AgentTask, state: AgentState): Promise<AgentDecisionDTO>;
}

/**
 * Deterministic brain: proposes the task's transfer and explains itself in
 * plain language. Reproducible, so the demo shows the same story every run.
 */
export const scriptedBrain: AgentBrain = {
  async decide(task, state) {
    const affordable = task.amount <= state.availableBalance;
    if (!affordable) {
      return {
        action: "hold",
        reasoning: `Holding: ${task.recipientLabel} needs more than the balance covers.`,
      };
    }
    return {
      action: "transfer",
      reasoning: task.prompt,
      proposedAmount: task.amount,
      recipient: task.recipient,
    };
  },
};

export interface RunAgentOptions {
  readonly tasks: readonly AgentTask[];
  readonly policy: SpendPolicyDTO;
  readonly initialState: AgentState;
  readonly brain?: AgentBrain;
  /** Called as each step happens, so a UI can render the loop live. */
  readonly onStep?: (step: AgentStep) => void | Promise<void>;
}

export interface AgentRunResult {
  readonly steps: readonly AgentStep[];
  readonly executed: readonly AgentDecisionDTO[];
  readonly refused: readonly AgentDecisionDTO[];
  readonly finalState: AgentState;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const brain = options.brain ?? scriptedBrain;
  const steps: AgentStep[] = [];
  const executed: AgentDecisionDTO[] = [];
  const refused: AgentDecisionDTO[] = [];

  let state = options.initialState;

  const emit = async (step: AgentStep) => {
    steps.push(step);
    await options.onStep?.(step);
  };

  for (const task of options.tasks) {
    await emit({
      kind: "observe",
      text: `${task.recipientLabel} — balance ${format(state.availableBalance)}, spent ${format(state.spentThisPeriod)} this period.`,
    });

    const decision = await brain.decide(task, state);

    await emit({ kind: "think", text: decision.reasoning });

    if (decision.action !== "transfer" || decision.proposedAmount === undefined) {
      await emit({ kind: "refused", text: `No transfer: agent chose to ${decision.action}.` });
      refused.push(decision);
      continue;
    }

    await emit({
      kind: "decide",
      text: `Proposes sending ${format(decision.proposedAmount)} to ${task.recipientLabel}.`,
      amount: decision.proposedAmount,
      recipient: decision.recipient,
    });

    const verdict = evaluateSpendPolicy(decision, {
      policy: options.policy,
      spentThisPeriod: state.spentThisPeriod,
      availableBalance: state.availableBalance,
    });

    if (!verdict.compliant) {
      // The refusal is enforced outside the model: whatever the agent decided,
      // the transfer does not happen.
      await emit({ kind: "refused", text: `Blocked by spend policy — ${verdict.reason}` });
      refused.push(decision);
      continue;
    }

    await emit({ kind: "policy", text: "Within the owner's spend policy." });
    await emit({
      kind: "execute",
      text: `Sent confidentially. The amount is encrypted on-chain.`,
      amount: decision.proposedAmount,
      recipient: decision.recipient,
    });

    executed.push(decision);
    state = {
      availableBalance: state.availableBalance - decision.proposedAmount,
      spentThisPeriod: state.spentThisPeriod + decision.proposedAmount,
    };
  }

  return { steps, executed, refused, finalState: state };
}

function format(baseUnits: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const fraction = (baseUnits % divisor).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${fraction} USDC`;
}
