import type { Address, TransactionSigner } from "@solana/kit";
import { buildAuthorizeSpendV2Instruction } from "../data/policy-program-v2";
import { sendInstructionsWithSigner } from "../data/solana-client";
import type { SolanaClient } from "../data/solana-client";
import { getOwnerTransactionSigner } from "./wallet-connection";
import type { WalletConnectionDTO } from "../dto/wallet.dto";

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

export interface AgentRunTask {
  readonly label: string;
  readonly reasoning: string;
  readonly amount: bigint;
  readonly recipient: string;
}

export type AgentRunOutcome =
  | { readonly status: "authorized"; readonly signature: string }
  | { readonly status: "refused"; readonly reason: string };

export interface AgentRunStepDTO {
  readonly task: AgentRunTask;
  readonly outcome: AgentRunOutcome;
}

export interface RunAgentOnChainParams {
  readonly client: SolanaClient;
  readonly ownerWallet: WalletConnectionDTO;
  readonly policyAccount: Address;
  /** Kept in memory for the session only — see agent-provisioning.ts. */
  readonly agentSigner: TransactionSigner;
  readonly tasks: readonly AgentRunTask[];
  readonly onStep: (step: AgentRunStepDTO) => void | Promise<void>;
}

export async function runAgentOnChain(params: RunAgentOnChainParams): Promise<void> {
  const ownerSigner = getOwnerTransactionSigner(params.ownerWallet);

  for (const task of params.tasks) {
    const outcome = await authorizeOnChain({
      client: params.client,
      ownerSigner,
      policyAccount: params.policyAccount,
      agentSigner: params.agentSigner,
      amount: task.amount,
    });
    await params.onStep({ task, outcome });
  }
}

async function authorizeOnChain(params: {
  client: SolanaClient;
  ownerSigner: TransactionSigner;
  policyAccount: Address;
  agentSigner: TransactionSigner;
  amount: bigint;
}): Promise<AgentRunOutcome> {
  const instruction = buildAuthorizeSpendV2Instruction({
    policyAccount: params.policyAccount,
    agent: params.agentSigner,
    amount: params.amount,
  });

  try {
    const signature = await sendInstructionsWithSigner(params.client, params.ownerSigner, [
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
