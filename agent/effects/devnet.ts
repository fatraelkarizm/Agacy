import type { Address, TransactionSigner } from "@solana/kit";
import { ElGamalCiphertext, type ElGamalPubkey } from "@solana/zk-sdk/node";
import type { SolanaClient } from "../../server/data/solana-client.js";
import { sendInstructions } from "../../server/data/confidential-mint.js";
import { executeConfidentialTransfer } from "../../server/data/confidential-transfer.js";
import { policyGatedConfidentialTransfer } from "../../server/data/confidential-transfer-policy.js";
import { fetchConfidentialBalance } from "../../server/data/confidential-balance.js";
import { deriveReasoningKey, encryptReasoning } from "../../server/data/reasoning-crypto.js";
import { buildMemoInstruction } from "../../server/data/memo.js";
import type { ConfidentialKeys } from "../../server/data/confidential-keys.js";
import type { loadOrCreatePayer } from "../../server/data/solana-payer.js";
import type { AgentEffects } from "../tools/toolkit.js";
import { fetchPolicyV2Account } from "../../server/data/policy-program-v2.js";
import { fetchTokenPrice, fetchSwapQuote } from "./jupiter.js";

/**
 * Real devnet effects for the autonomous loop's toolset.
 *
 * `payConfidentially` re-reads the on-chain ciphertext immediately before
 * building proofs, same as capture-devnet-proof.ts and every other script in
 * this codebase — proofs must be built over the actual stored ciphertext, not
 * a value cached from an earlier step, or they fail verification on-chain.
 * The reasoning the model gives is encrypted and carried as a Memo in the
 * same style, so the audit trail for *why* the agent paid is protected the
 * same way the amount is, not just logged locally.
 *
 * Price and quote effects hit Jupiter's real mainnet API even while the agent
 * runs on devnet: they are read-only market data, not an on-chain action, so
 * there is nothing devnet-specific to fake. `swap_tokens` itself still refuses
 * on devnet (see tools/toolkit.ts) — only information gathering is shared.
 */

export interface DevnetEffectsDeps {
  readonly client: SolanaClient;
  readonly payer: Awaited<ReturnType<typeof loadOrCreatePayer>>;
  readonly senderAccount: Address;
  readonly senderKeys: ConfidentialKeys;
  readonly mint: Address;
  /** Reasoning is encrypted under a key derived from this signature — same derivation as confidential-keys.ts, domain-separated. */
  readonly reasoningSeedSignature: Uint8Array;
  readonly recipientAccounts: ReadonlyMap<string, { pubkey: ElGamalPubkey }>;
  /**
   * When set, payments are forwarded through the deployed policy program
   * instead of being signed directly by the account owner.
   *
   * This is the difference between a limit the agent could route around and
   * one it cannot. Without it, `agent/policy-guard.ts` is the only thing
   * enforcing the budget — good hygiene, but enforcement by our own wrapper is
   * exactly what this project argues is not enough. With it, the token account
   * answers to the program, and the only signature that moves funds is one the
   * program produces after checking the limit.
   *
   * Requires the policy PDA to already hold custody of `senderAccount`.
   */
  readonly onChainPolicy?: {
    readonly policyAccount: Address;
    readonly agent: TransactionSigner;
    readonly maxPerTransfer: bigint;
    readonly maxPerPeriod: bigint;
  };
}

export function buildDevnetEffects(deps: DevnetEffectsDeps): AgentEffects {
  return {
    async payConfidentially({ amount, recipient, reasoning }) {
      const recipientKeys = deps.recipientAccounts.get(recipient);
      if (!recipientKeys) {
        throw new Error(
          `No confidential recipient keys registered for ${recipient}. ` +
            "This demo only knows the recipients set up for the run.",
        );
      }

      const state = await fetchConfidentialBalance(deps.client, deps.senderAccount, deps.senderKeys);
      const reasoningKey = await deriveReasoningKey(deps.reasoningSeedSignature);
      const ciphertext = await encryptReasoning(reasoningKey, reasoning);
      const memo = buildMemoInstruction(
        new TextEncoder().encode(Buffer.from(ciphertext).toString("base64")),
      );
      const { signature } = deps.onChainPolicy
        ? await policyGatedConfidentialTransfer(deps.client, deps.payer, {
            policyAccount: deps.onChainPolicy.policyAccount,
            agent: deps.onChainPolicy.agent,
            sourceToken: deps.senderAccount,
            destinationToken: recipient as Address,
            mint: deps.mint,
            senderKeys: deps.senderKeys,
            recipientElGamalPubkey: recipientKeys.pubkey,
            availableBalance: state.availableBalance,
            availableBalanceCiphertext: state.availableBalanceCiphertext,
            amount,
            maxPerTransfer: deps.onChainPolicy.maxPerTransfer,
            maxPerPeriod: deps.onChainPolicy.maxPerPeriod,
            additionalInstructions: [memo],
          })
        : await executeConfidentialTransfer(deps.client, deps.payer, {
            sourceToken: deps.senderAccount,
            destinationToken: recipient as Address,
            mint: deps.mint,
            owner: deps.payer,
            senderKeys: deps.senderKeys,
            recipientElGamalPubkey: recipientKeys.pubkey,
            availableBalance: state.availableBalance,
            availableBalanceCiphertext: state.availableBalanceCiphertext,
            amount,
          });

      // The policy path included this in the transfer transaction atomically.
      // The direct-owner fallback is only a legacy/demo path and still needs a
      // second transaction because its transfer helper owns submission.
      if (!deps.onChainPolicy) await sendInstructions(deps.client, deps.payer, [memo]);

      return { signature };
    },

    async requestDevnetAirdrop({ lamports }) {
      // The public devnet faucet genuinely rate-limits (confirmed live: a
      // 403 on the very next request after this project's own earlier
      // faucet use today) — the same reason solana-client.ts's
      // fundFromFaucet retries rather than failing on the first attempt.
      // Retried here directly, rather than delegating to that helper,
      // because it discards the signature this tool needs to report back.
      let lastError: unknown;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const signature = await deps.client.rpc
            .requestAirdrop(deps.payer.address, lamports as never, { commitment: "confirmed" })
            .send();
          return { signature: signature as string };
        } catch (error) {
          lastError = error;
          if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        }
      }
      throw lastError;
    },

    async readOnChainPolicy() {
      if (!deps.onChainPolicy) return null;
      const state = await fetchPolicyV2Account(deps.client, deps.onChainPolicy.policyAccount);
      if (!state) return null;
      const encryptedSpent = state.confidentialLimits
        ? ElGamalCiphertext.fromBytes(state.confidentialLimits.spentInPeriodCt)
        : null;
      return {
        policyAccount: deps.onChainPolicy.policyAccount,
        maxPerTransfer: state.confidentialLimits
          ? deps.onChainPolicy.maxPerTransfer
          : state.maxPerTransfer,
        maxPerPeriod: state.confidentialLimits
          ? deps.onChainPolicy.maxPerPeriod
          : state.maxPerPeriod,
        spentInPeriod: encryptedSpent
          ? deps.senderKeys.elGamal.secret().decrypt(encryptedSpent)
          : state.spentInPeriod,
        custodiedTokenAccount: state.custodiedTokenAccount,
        limitsAreConfidential: state.confidentialLimits !== null,
      };
    },

    fetchTokenPrice: ({ mint }) => fetchTokenPrice(mint),
    fetchSwapQuote,

    async executeSwap() {
      throw new Error("Swaps cannot execute on devnet — this effect should never be reached here.");
    },
  };
}
