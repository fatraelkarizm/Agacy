import { generateKeyPairSigner, type Address, type TransactionSigner } from "@solana/kit";
import {
  buildAuthorizeSpendV2Instruction,
  buildUpdateLimitsV2Instruction,
} from "../data/policy-program-v2";
import { sendInstructionsWithSigner } from "../data/solana-client";
import type { SolanaClient } from "../data/solana-client";
import { getOwnerTransactionSigner } from "./wallet-connection";
import { customErrorCode } from "./agent-run";
import type { WalletConnectionDTO } from "../dto/wallet.dto";

/**
 * Attacks that actually run.
 *
 * The previous "simulate attacker" narrated what an attacker would see. It was
 * accurate, but nothing was attacked — it read as a description, because it was
 * one. These send real transactions to the deployed program on devnet and
 * report what the program did with them.
 *
 * Each one is a plausible failure of the thing this project claims: an agent
 * that talks itself into a bigger budget, a leaked agent key, a payment past
 * the ceiling. If the claims are wrong, this is where it shows.
 *
 * Two rules make this evidence rather than theatre:
 *
 * 1. **Nothing is hardcoded to fail.** Each attack reports whatever the chain
 *    returned. A success is rendered as a breach, loudly, because a security
 *    demo that cannot fail is not demonstrating security.
 * 2. **Nothing is destructive.** Every attack here is refused by design, so
 *    running one costs a transaction fee and changes nothing. The one attack
 *    that *does* move state on success — spending against the budget — is the
 *    one the owner already authorized anyway.
 */

/** Anchor custom error numbers; must match the program's error.rs. */
const ERROR_EXCEEDS_PER_TRANSFER_LIMIT = 6001;
const ERROR_EXCEEDS_PERIOD_LIMIT = 6002;
const ERROR_ILLEGAL_SIGNER = 6003;

export interface AttackDefinition {
  readonly id: string;
  /** What the attacker is trying to achieve, in their words. */
  readonly goal: string;
  /** The mechanism, one line. */
  readonly method: string;
  /** What should stop it, so a reader can tell a pass from a lucky no-op. */
  readonly defence: string;
  readonly expectedError: number;
}

export const ATTACKS: readonly AttackDefinition[] = [
  {
    id: "raise-own-limit",
    goal: "Give myself a bigger budget",
    method: "Agent signs update_limits, setting its own ceiling to 1,000,000 USDC",
    defence: "Only the owner key can change limits",
    expectedError: ERROR_ILLEGAL_SIGNER,
  },
  {
    id: "stolen-key",
    goal: "Spend with a stolen key",
    method: "A different keypair signs authorize against this policy",
    defence: "The program checks the signer against the agent stored in the policy",
    expectedError: ERROR_ILLEGAL_SIGNER,
  },
  {
    id: "over-limit",
    goal: "Pay more than the per-transfer cap",
    method: "Agent authorizes a payment above its limit",
    defence: "The limit is account state, not an instruction to the model",
    expectedError: ERROR_EXCEEDS_PER_TRANSFER_LIMIT,
  },
  {
    id: "drain-period",
    goal: "Split the spend to slip past the period budget",
    method: "Agent authorizes repeated in-limit payments until the period is exhausted",
    defence: "Spending accumulates on-chain, so splitting it changes nothing",
    expectedError: ERROR_EXCEEDS_PERIOD_LIMIT,
  },
];

export type AttackResult =
  | { readonly status: "blocked"; readonly code: number; readonly detail: string }
  | { readonly status: "breached"; readonly signature: string }
  /** Reached the chain but failed for a reason unrelated to the defence. */
  | { readonly status: "inconclusive"; readonly detail: string };

export interface RunAttackParams {
  readonly client: SolanaClient;
  readonly ownerWallet: WalletConnectionDTO;
  readonly policyAccount: Address;
  readonly agentSigner: TransactionSigner;
  readonly maxPerTransfer: bigint;
  readonly attack: AttackDefinition;
}

export async function runAttack(params: RunAttackParams): Promise<AttackResult> {
  const owner = getOwnerTransactionSigner(params.ownerWallet);
  let landed = "";
  const send = async (instruction: unknown) => {
    landed = await sendInstructionsWithSigner(params.client, owner, [instruction as never]);
  };

  try {
    switch (params.attack.id) {
      case "raise-own-limit":
        // The agent is passed where the program expects the owner. Anchor's
        // `has_one = owner` compares against stored state, so this cannot work
        // no matter how convincingly an agent argues for it.
        await send(
          buildUpdateLimitsV2Instruction({
            policyAccount: params.policyAccount,
            owner: params.agentSigner,
            maxPerTransfer: 1_000_000_000_000n,
            maxPerPeriod: 1_000_000_000_000n,
          }),
        );
        break;

      case "stolen-key": {
        const thief = await generateKeyPairSigner();
        await send(
          buildAuthorizeSpendV2Instruction({
            policyAccount: params.policyAccount,
            agent: thief,
            amount: 1_000_000n,
          }),
        );
        break;
      }

      case "over-limit":
        await send(
          buildAuthorizeSpendV2Instruction({
            policyAccount: params.policyAccount,
            agent: params.agentSigner,
            amount: params.maxPerTransfer + 1n,
          }),
        );
        break;

      case "drain-period": {
        // Every individual payment here is inside the per-transfer limit, which
        // is the point: the attack is the splitting, not the size.
        for (let attempt = 0; attempt < 12; attempt++) {
          await send(
            buildAuthorizeSpendV2Instruction({
              policyAccount: params.policyAccount,
              agent: params.agentSigner,
              amount: params.maxPerTransfer,
            }),
          );
        }
        break;
      }

      default:
        return { status: "inconclusive", detail: "Unknown attack." };
    }
  } catch (error) {
    const code = customErrorCode(error);
    if (code === null) {
      return {
        status: "inconclusive",
        detail:
          error instanceof Error
            ? error.message
            : "The attack never reached the program — check the wallet and SOL balance.",
      };
    }
    if (code !== params.attack.expectedError) {
      // Refused, but not by the defence being demonstrated. Saying "blocked"
      // here would credit the wrong mechanism.
      return {
        status: "inconclusive",
        detail: `Refused with error ${code}, not the expected ${params.attack.expectedError}.`,
      };
    }
    return { status: "blocked", code, detail: params.attack.defence };
  }

  // Falling through the try means no error was raised: the attack landed. The
  // signature is returned so the breach is checkable rather than just alarming.
  return { status: "breached", signature: landed };
}
