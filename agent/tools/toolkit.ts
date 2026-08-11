import { z } from "zod";
import type { Cluster } from "../network.js";
import type { SpendPolicyDTO } from "../../server/dto/agent.dto.js";

/**
 * The autonomous agent's toolset.
 *
 * Every tool declares whether it moves value via `spendAmount`. That is not
 * documentation — `policy-guard.ts` reads it to decide what to gate, so a tool
 * that moves money without declaring it is a policy bypass. `null` is a
 * deliberate statement ("this is read-only"), never a default, which is why
 * the field is required rather than optional.
 *
 * Units, stated plainly because mixing them silently would be a real bug:
 * `spendAmount` is in base units of the *payment token* (the confidential
 * USDC-like mint, 6 decimals) and is what SpendPolicyDTO limits. SOL-denominated
 * spending on mainnet (swap input) is bounded separately by the ceiling in
 * `authorizeMainnetRun` — one policy cannot meaningfully cap two different
 * assets, so each is capped in its own unit rather than pretending otherwise.
 */

export interface ToolContext {
  readonly cluster: Cluster;
  readonly ownerAddress: string;
  readonly policy: SpendPolicyDTO;
  /** Spent so far this period, in payment-token base units. */
  readonly spentThisPeriod: bigint;
  /** Confidential balance available to spend, in payment-token base units. */
  readonly availableBalance: bigint;
  /** Public SOL balance in lamports, for fee/swap decisions. */
  readonly solLamports: bigint;
  /** Ceiling for real-money SOL spending. Zero on devnet. */
  readonly maxSpendSol: number;
  readonly effects: AgentEffects;
}

/**
 * Side effects are injected rather than imported so the toolset can be tested
 * without a cluster, and so a caller can decide what "execute" means (a real
 * devnet transaction, a mainnet transaction, or a refusal).
 */
export interface AgentEffects {
  payConfidentially(input: {
    amount: bigint;
    recipient: string;
    reasoning: string;
  }): Promise<{ signature: string }>;
  requestDevnetAirdrop(input: { lamports: bigint }): Promise<{ signature: string }>;
  /**
   * The policy as the chain holds it, or `null` when this run is not gated
   * on-chain. Deliberately separate from the locally-tracked budget the guard
   * keeps: if the two ever disagree, the chain is right and the difference is
   * worth seeing rather than smoothing over.
   */
  readOnChainPolicy(): Promise<{
    policyAccount: string;
    maxPerTransfer: bigint;
    maxPerPeriod: bigint;
    spentInPeriod: bigint;
    custodiedTokenAccount: string | null;
    limitsAreConfidential: boolean;
  } | null>;
  fetchTokenPrice(input: { mint: string }): Promise<{ mint: string; priceUsd: number | null }>;
  fetchSwapQuote(input: {
    inputMint: string;
    outputMint: string;
    amountLamports: bigint;
  }): Promise<{ inAmount: string; outAmount: string; priceImpactPct: string | null }>;
  executeSwap(input: {
    inputMint: string;
    outputMint: string;
    amountLamports: bigint;
  }): Promise<{ signature: string }>;
}

export interface AgacyTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<Record<string, unknown>>;
  /**
   * Payment-token base units this call would spend, or `null` for read-only
   * tools. Read by policy-guard.ts — see this file's header.
   */
  readonly spendAmount: ((input: Record<string, never>) => bigint) | null;
  readonly execute: (input: never, context: ToolContext) => Promise<unknown>;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const PAYMENT_TOKEN_DECIMALS = 6;

function toBaseUnits(whole: number, decimals: number): bigint {
  return BigInt(Math.round(whole * 10 ** decimals));
}

const payVendorSchema = z.object({
  amount: z.number().positive().describe("Amount to pay, in whole payment tokens (e.g. 4.25)"),
  recipient: z.string().min(32).describe("Recipient's token account address"),
  reasoning: z
    .string()
    .min(1)
    .describe("Why this payment is being made, in plain language. Encrypted on-chain, owner-only."),
});

const airdropSchema = z.object({
  sol: z.number().positive().max(2).describe("How much devnet SOL to request (max 2 per request)"),
});

const priceSchema = z.object({
  mint: z.string().min(32).describe("Token mint address to price"),
});

const quoteSchema = z.object({
  inputMint: z.string().min(32).describe("Mint being sold"),
  outputMint: z.string().min(32).describe("Mint being bought"),
  sol: z.number().positive().describe("Input amount in whole SOL"),
});

const swapSchema = quoteSchema;

export function buildToolkit(): readonly AgacyTool[] {
  return [
    {
      name: "get_wallet_overview",
      description:
        "Read the agent's current situation: cluster, owner address, confidential payment-token " +
        "balance, public SOL balance, spend policy limits, and how much of the period budget is " +
        "already used. Call this before deciding anything that costs money.",
      schema: z.object({}),
      spendAmount: null,
      execute: async (_input, context) => ({
        cluster: context.cluster,
        ownerAddress: context.ownerAddress,
        availablePaymentBalance: context.availableBalance.toString(),
        solBalanceLamports: context.solLamports.toString(),
        policy: {
          maxPerTransfer: context.policy.maxPerTransfer.toString(),
          maxPerPeriod: context.policy.maxPerPeriod.toString(),
          spentThisPeriod: context.spentThisPeriod.toString(),
          remainingThisPeriod: (
            context.policy.maxPerPeriod - context.spentThisPeriod
          ).toString(),
          allowedRecipients:
            context.policy.allowedRecipients.length > 0
              ? context.policy.allowedRecipients
              : "any recipient allowed",
        },
        realFundsAtRisk: context.cluster === "mainnet",
        maxSpendSol: context.maxSpendSol,
      }),
    },

    {
      name: "check_on_chain_policy",
      description:
        "Read the spend policy straight from the deployed program on-chain, rather than from " +
        "this run's local bookkeeping. Tells you the real limits, how much of the period budget " +
        "the chain has recorded as spent, and whether the policy program holds custody of the " +
        "payment account. Use it to confirm what is actually enforced before planning a large " +
        "payment, or when a payment was refused and you want the authoritative reason.",
      schema: z.object({}),
      spendAmount: null,
      execute: async (_input, context) => {
        const state = await context.effects.readOnChainPolicy();
        if (!state) {
          return {
            status: "not_gated_on_chain",
            note:
              "This run is not bound to a policy account, so limits are enforced only by the " +
              "local guard. Treat the numbers from get_wallet_overview as advisory.",
          };
        }
        return {
          status: "enforced_on_chain",
          policyAccount: state.policyAccount,
          maxPerTransfer: state.maxPerTransfer.toString(),
          maxPerPeriod: state.maxPerPeriod.toString(),
          spentThisPeriodOnChain: state.spentInPeriod.toString(),
          remainingThisPeriod: (state.maxPerPeriod - state.spentInPeriod).toString(),
          custodiedTokenAccount: state.custodiedTokenAccount,
          limitsAreConfidential: state.limitsAreConfidential,
          note:
            "These are the numbers the program enforces. If they disagree with " +
            "get_wallet_overview, these win.",
        };
      },
    },

    {
      name: "pay_vendor_confidentially",
      description:
        "Pay a vendor using Agacy's confidential transfer. Devnet only in this build — running a " +
        "confidential-transfer mint and accounts on mainnet is a separate, unrelated setup this " +
        "toolkit does not provision. The amount and the resulting balance are encrypted on-chain " +
        "— a public observer sees only that a transaction happened. Your reasoning is encrypted " +
        "too and readable only by the owner. Subject to the owner's spend policy: a request " +
        "outside the limits is refused and nothing moves.",
      schema: payVendorSchema,
      spendAmount: (input) => {
        const { amount } = payVendorSchema.parse(input);
        return toBaseUnits(amount, PAYMENT_TOKEN_DECIMALS);
      },
      execute: async (input, context) => {
        const { amount, recipient, reasoning } = payVendorSchema.parse(input);
        if (context.cluster !== "devnet") {
          return {
            status: "unavailable",
            reason:
              "Confidential transfer is only wired up on devnet in this build. This run is on " +
              "mainnet, where it would need its own confidential mint and accounts to be " +
              "provisioned first — a separate task from swapping.",
          };
        }
        const result = await context.effects.payConfidentially({
          amount: toBaseUnits(amount, PAYMENT_TOKEN_DECIMALS),
          recipient,
          reasoning,
        });
        return {
          status: "paid",
          signature: result.signature,
          confidential: true,
          note: "Amount and reasoning are encrypted on-chain.",
        };
      },
    },

    {
      name: "request_devnet_airdrop",
      description:
        "Top up the agent's SOL from the devnet faucet. Devnet only — this does nothing on " +
        "mainnet, where SOL has to be funded by the owner. Use when SOL is too low to cover fees.",
      schema: airdropSchema,
      spendAmount: null,
      execute: async (input, context) => {
        const { sol } = airdropSchema.parse(input);
        if (context.cluster !== "devnet") {
          return {
            status: "unavailable",
            reason: "The faucet only exists on devnet. On mainnet the owner must fund the wallet.",
          };
        }
        const result = await context.effects.requestDevnetAirdrop({
          lamports: BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL))),
        });
        return { status: "funded", signature: result.signature };
      },
    },

    {
      name: "get_token_price",
      description:
        "Look up a token's current USD price. Read-only, costs nothing. Prices come from " +
        "mainnet market data even when the agent is operating on devnet, so treat a devnet " +
        "price as reference information rather than something you can trade against.",
      schema: priceSchema,
      spendAmount: null,
      execute: async (input, context) => {
        const { mint } = priceSchema.parse(input);
        return context.effects.fetchTokenPrice({ mint });
      },
    },

    {
      name: "get_swap_quote",
      description:
        "Get a routed swap quote (how much output you would receive for a given input). " +
        "Read-only and free — it does not swap anything. Use it to decide whether a swap is " +
        "worth executing before calling swap_tokens.",
      schema: quoteSchema,
      spendAmount: null,
      execute: async (input, context) => {
        const { inputMint, outputMint, sol } = quoteSchema.parse(input);
        return context.effects.fetchSwapQuote({
          inputMint,
          outputMint,
          amountLamports: BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL))),
        });
      },
    },

    {
      name: "swap_tokens",
      description:
        "Swap one token for another through Jupiter. This spends REAL money and only works on " +
        "mainnet — the router has no devnet deployment, so on devnet this call is refused rather " +
        "than simulated. Bounded by the owner's SOL spend ceiling for the run.",
      schema: swapSchema,
      // Denominated in SOL, not the payment token, so the payment-token policy
      // cannot meaningfully cap it — the SOL ceiling in the guard does. See
      // this file's header on units.
      spendAmount: null,
      execute: async (input, context) => {
        const { inputMint, outputMint, sol } = swapSchema.parse(input);

        if (context.cluster !== "mainnet") {
          return {
            status: "refused",
            reason:
              "Jupiter has no devnet endpoint, so this swap cannot be executed or honestly " +
              "simulated here. Re-run on mainnet to execute it for real.",
          };
        }
        if (sol > context.maxSpendSol) {
          return {
            status: "refused",
            reason: `Swapping ${sol} SOL exceeds this run's ceiling of ${context.maxSpendSol} SOL.`,
          };
        }
        if (BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL))) > context.solLamports) {
          return { status: "refused", reason: "Not enough SOL in the wallet for that swap." };
        }

        const result = await context.effects.executeSwap({
          inputMint,
          outputMint,
          amountLamports: BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL))),
        });
        return { status: "swapped", signature: result.signature, realFunds: true };
      },
    },
  ];
}
