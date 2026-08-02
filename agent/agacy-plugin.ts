import { z } from "zod";
import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import type { SpendPolicyDTO } from "../server/dto/agent.dto";
import { evaluateSpendPolicy } from "../server/services/spend-policy";

/**
 * Agacy as a Solana Agent Kit plugin.
 *
 * Agent Kit supplies the parts that are not our problem to invent: the
 * tool-calling loop, LangChain/Vercel-AI/OpenAI adapters, and 60+ standard
 * on-chain actions. We contribute the one action it does not have — a transfer
 * whose amount is encrypted on-chain.
 *
 * A compatibility note worth stating plainly: Agent Kit v2 is built on the
 * legacy `@solana/web3.js` and `@solana/spl-token@0.4.x`, and that version of
 * spl-token has no confidential transfer support at all. So the action below
 * does not route through Agent Kit's connection — it calls our own data layer,
 * which uses `@solana/kit` v7 and `@solana-program/token-2022`. The two SDKs
 * coexist as separate dependencies; Agent Kit orchestrates, we execute.
 */

export interface AgacyPluginConfig {
  readonly policy: SpendPolicyDTO;
  /** Reads live spend state. Kept injectable so the plugin owns no state itself. */
  readonly getState: () => Promise<{ availableBalance: bigint; spentThisPeriod: bigint }>;
  /** Performs the confidential transfer. Returns the transaction signature. */
  readonly transfer: (amount: bigint, recipient: string) => Promise<string>;
}

const transferSchema = z.object({
  amount: z.number().positive().describe("Amount to send, in whole tokens"),
  recipient: z.string().describe("Recipient's token account address"),
  decimals: z.number().int().min(0).max(9).default(6),
});

export function createAgacyPlugin(config: AgacyPluginConfig): Plugin {
  const confidentialTransfer: Action = {
    name: "AGACY_CONFIDENTIAL_TRANSFER",
    similes: [
      "send tokens privately",
      "confidential transfer",
      "pay without revealing the amount",
      "private payment",
    ],
    description:
      "Send tokens with the amount encrypted on-chain. The transaction is publicly verifiable " +
      "but the amount and resulting balance are readable only by the owner. Subject to the " +
      "owner's spend policy; requests outside it are refused and no transfer occurs.",
    examples: [
      [
        {
          input: { amount: 4.2, recipient: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK" },
          output: { status: "success", signature: "5xTest…", confidential: true },
          explanation: "Pays a subscription without publishing the amount on-chain.",
        },
      ],
    ],
    schema: transferSchema,
    handler: async (_agent: SolanaAgentKit, input: Record<string, unknown>) => {
      const { amount, recipient, decimals } = transferSchema.parse(input);
      const baseUnits = BigInt(Math.round(amount * 10 ** decimals));

      const state = await config.getState();
      const verdict = evaluateSpendPolicy(
        { action: "transfer", reasoning: "agent-initiated", proposedAmount: baseUnits, recipient },
        { policy: config.policy, ...state },
      );

      // A refusal is returned as a result, not thrown: the agent should be able
      // to reason about why it was blocked and pick a different action.
      if (!verdict.compliant) {
        return { status: "refused", reason: verdict.reason };
      }

      const signature = await config.transfer(baseUnits, recipient);
      return { status: "success", signature, confidential: true };
    },
  };

  return {
    name: "agacy",
    methods: {},
    actions: [confidentialTransfer],
    initialize() {
      // No per-agent setup: the plugin's dependencies are injected at creation
      // rather than pulled off the agent, which keeps it testable without a
      // live SolanaAgentKit instance.
    },
  };
}
