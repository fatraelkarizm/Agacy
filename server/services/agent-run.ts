import type { Address, TransactionSigner } from "@solana/kit";
import { buildAuthorizeSpendV2Instruction } from "../data/policy-program-v2";
import { sendInstructionsWithSigner } from "../data/solana-client";
import type { SolanaClient } from "../data/solana-client";
import type {
  AgentRunGraphEventDTO,
  AgentRunOutcomeDTO,
  AgentRunStepDTO,
  AgentRunTaskDTO,
  AuthorizedAgentRunEventDTO,
  PublicAgentRunEventDTO,
} from "../dto/agent-run.dto";

/**
 * Running an agent against the real policy account on devnet.
 *
 * This replaces a scripted walkthrough that decided locally whether a payment
 * was allowed and then announced it had sent one. It had not: there was no
 * executor, and "the amount is encrypted on-chain" described a transaction that
 * did not exist. A demo that claims more than it does is worse than a plainer
 * one that is true, because the first thing a sceptical reviewer does is open
 * an explorer.
 *
 * So the verdict now comes from the chain. Each proposed payment sends a real
 * `authorize` to the deployed policy program, signed by the agent. Approval
 * means the program accepted it and there is a signature to open; refusal means
 * the program rejected it, and the reason is the on-chain error, not a string
 * this file chose.
 *
 * Two signatures per call, which is the point rather than an inconvenience:
 * the owner's wallet pays the fee, and the agent signs as the agent. Neither
 * can stand in for the other — the program checks the agent key against the one
 * stored in the policy, so the owner cannot spend as their own agent and the
 * agent cannot pay its own way.
 *
 * Deliberately still out of scope here: the token transfer itself. Moving value
 * confidentially needs a mint, funded accounts, and three proof-context
 * accounts per payment, which is a poor fit for a browser session and is
 * exercised properly by the devnet scripts instead. What this proves is the
 * part that was previously only asserted — that the limit is enforced by the
 * chain rather than by the interface.
 */

/** Anchor numbers custom errors from 6000; must match the program's error.rs. */
const PROGRAM_ERRORS: Record<number, string> = {
  6000: "Amount must be greater than zero.",
  6001: "Over the per-transfer limit.",
  6002: "Would exceed the limit for this period.",
  6003: "This key is not the agent this policy was created for.",
  6019: "This policy uses confidential limits and needs the confidential path.",
};

export interface RunAgentOnChainParams {
  readonly client: SolanaClient;
  readonly policyAccount: Address;
  /** Kept in memory for the session only — see agent-provisioning.ts. */
  readonly agentSigner: TransactionSigner;
  readonly goal: string;
  readonly tasks: readonly AgentRunTaskDTO[];
  readonly onStep: (step: AgentRunStepDTO) => void | Promise<void>;
  readonly onGraphEvent?: (event: AgentRunGraphEventDTO) => void | Promise<void>;
}

export async function runAgentOnChain(params: RunAgentOnChainParams): Promise<void> {
  await emitGraphEvent(params, {
    id: "goal",
    taskIndex: -1,
    kind: "goal",
    status: "completed",
    detail: params.goal,
  });

  for (const [taskIndex, task] of params.tasks.entries()) {
    await emitGraphEvent(params, {
      id: `${taskIndex}-observe`,
      taskIndex,
      kind: "observe",
      status: "completed",
      taskLabel: task.label,
      detail: task.reasoning,
    });
    await emitGraphEvent(params, {
      id: `${taskIndex}-decide`,
      taskIndex,
      kind: "decide",
      status: "completed",
      taskLabel: task.label,
      detail: "Proposed a confidential payment.",
      amount: task.amount,
      recipient: task.recipient,
    });
    await emitGraphEvent(params, {
      id: `${taskIndex}-policy`,
      taskIndex,
      kind: "policy",
      status: "running",
      taskLabel: task.label,
      detail: "Waiting for the on-chain policy program.",
      amount: task.amount,
      recipient: task.recipient,
    });

    const outcome = await authorizeOnChain({
      client: params.client,
      policyAccount: params.policyAccount,
      agentSigner: params.agentSigner,
      amount: task.amount,
    });

    await emitGraphEvent(params, {
      id: `${taskIndex}-policy`,
      taskIndex,
      kind: "policy",
      status: outcome.status === "authorized" ? "approved" : "rejected",
      taskLabel: task.label,
      detail:
        outcome.status === "authorized"
          ? "Approved by the deployed policy program."
          : outcome.reason,
      amount: task.amount,
      recipient: task.recipient,
    });

    await emitGraphEvent(
      params,
      outcome.status === "authorized"
        ? {
            id: `${taskIndex}-execute`,
            taskIndex,
            kind: "execute",
            status: "confirmed",
            taskLabel: task.label,
            detail: "Authorization confirmed on Solana devnet.",
            amount: task.amount,
            recipient: task.recipient,
            signature: outcome.signature,
          }
        : {
            id: `${taskIndex}-refused`,
            taskIndex,
            kind: "refused",
            status: "rejected",
            taskLabel: task.label,
            detail: outcome.reason,
            amount: task.amount,
            recipient: task.recipient,
          },
    );
    await params.onStep({ task, outcome });
  }
}

async function emitGraphEvent(
  params: RunAgentOnChainParams,
  authorized: AuthorizedAgentRunEventDTO,
): Promise<void> {
  await params.onGraphEvent?.({
    authorized,
    public: toPublicAgentRunEvent(authorized),
  });
}

export function toPublicAgentRunEvent(
  event: AuthorizedAgentRunEventDTO,
): PublicAgentRunEventDTO {
  return {
    id: event.id,
    taskIndex: event.taskIndex,
    kind: event.kind,
    status: event.status,
    ...(event.signature === undefined ? {} : { signature: event.signature }),
  };
}

export function createAgentRunGoalEvent(goal: string): AgentRunGraphEventDTO {
  const authorized: AuthorizedAgentRunEventDTO = {
    id: "goal",
    taskIndex: -1,
    kind: "goal",
    status: "queued",
    detail: goal,
  };
  return { authorized, public: toPublicAgentRunEvent(authorized) };
}

async function authorizeOnChain(params: {
  client: SolanaClient;
  policyAccount: Address;
  agentSigner: TransactionSigner;
  amount: bigint;
}): Promise<AgentRunOutcomeDTO> {
  const instruction = buildAuthorizeSpendV2Instruction({
    policyAccount: params.policyAccount,
    agent: params.agentSigner,
    amount: params.amount,
  });

  try {
    const signature = await sendInstructionsWithSigner(params.client, params.agentSigner, [
      instruction,
    ]);
    return { status: "authorized", signature };
  } catch (error) {
    // A rejection from the program is the expected, interesting outcome — not
    // an exception to log and move past. Anything the program did not produce
    // is re-thrown, so a wallet or network failure is never dressed up as a
    // policy decision.
    const code = customErrorCode(error);
    if (code === null) throw error;
    return { status: "refused", reason: PROGRAM_ERRORS[code] ?? `Refused on-chain (error ${code}).` };
  }
}

/**
 * Pull the program's own error number out of whatever the RPC layer wrapped it
 * in. Preflight rejections arrive structured; simulation failures arrive as a
 * hex code inside the logs. Both shapes are checked rather than assuming one.
 */
export function customErrorCode(error: unknown): number | null {
  const structured = (error as { cause?: { context?: { code?: number } } })?.cause?.context?.code;
  if (typeof structured === "number") return structured;

  const text =
    JSON.stringify(error, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) +
    String((error as Error)?.message ?? "");

  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex?.[1]) return Number.parseInt(hex[1], 16);
  const decimal = text.match(/"Custom"\s*:\s*(\d+)/);
  if (decimal?.[1]) return Number.parseInt(decimal[1], 10);
  return null;
}
