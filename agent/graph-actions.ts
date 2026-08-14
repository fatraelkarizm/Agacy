import { z } from "zod";
import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import { address, type TransactionSigner } from "@solana/kit";
import type { SolanaClient } from "../server/data/solana-client";
import type { SpendPolicyDTO } from "../server/dto/agent.dto";
import type {
  AgentGraphToolName,
  AuthorizedAgentGraphToolResultDTO,
} from "../server/dto/agent-graph.dto";
import { formatTokens } from "../server/services/demo-scenario";
import { runAgentOnChain } from "../server/services/agent-run";
import { evaluateSpendPolicy, fetchOnChainPolicyStatus } from "../server/services/spend-policy";
import { fetchTokenPrice, fetchSwapQuote } from "./effects/jupiter";
import { fetchAisaResearch, fetchAisaTokenPrice, priceDivergencePercent } from "./effects/aisa";
import { payConfidentially } from "./effects/confidential-payment";

/**
 * The Agent Graph's toolset, expressed as Solana Agent Kit `Action` objects.
 *
 * Why this shape rather than a private switch statement: an Action is Agent
 * Kit's portable unit of capability. Defining the graph's tools this way means
 * the same objects can be handed to `createVercelAITools`, `createLangchainTools`,
 * or `createOpenAITools` without a second implementation — the graph stops being
 * a parallel agent runtime and becomes one consumer of a shared registry.
 *
 * Two constraints shaped this file, and both are real rather than stylistic:
 *
 * 1. **`solana-agent-kit` is imported for types only.** It declares
 *    `engines: node >= 22` and ships no browser build, while the graph executes
 *    its tools in the browser against a session key that never leaves the tab.
 *    Importing the runtime here would pull a Node-targeted package into the
 *    client bundle. Handlers are therefore invoked directly by the graph
 *    (`action.handler`), and the identical objects still satisfy Agent Kit's
 *    interface for any server-side consumer that wants the real runtime.
 *
 * 2. **Handlers ignore the `SolanaAgentKit` argument.** Agent Kit v2 is built on
 *    legacy `@solana/web3.js`, which has no confidential-transfer support; this
 *    project's data layer uses `@solana/kit` v7 and `@solana-program/token-2022`.
 *    So dependencies are injected through `GraphActionContext` instead of pulled
 *    off the agent — the same arrangement `agacy-plugin.ts` already uses, and the
 *    reason its handler names the parameter `_agent`.
 */

const TOKEN_SCALE = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Everything the graph's actions need, injected rather than read off an agent. */
export interface GraphActionContext {
  readonly client: SolanaClient;
  readonly ownerAddress: string;
  readonly policy: SpendPolicyDTO | null;
  readonly policyAccount: string | null;
  /** Session-scoped agent key. Lives in browser memory only — never transmitted. */
  readonly agentSigner: TransactionSigner | null;
  readonly spentThisPeriod: bigint;
  /**
   * The owner's original instruction. `authorize_policy_spend` checks the amount
   * and recipient against it, so the model cannot introduce either value.
   */
  readonly ownerGoal: string;
}

export const emptyInputSchema = z.object({});

export const tokenPriceInputSchema = z.object({
  mint: z.string().trim().min(32).max(64).describe("Token mint address to price"),
});

export const researchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Short search phrase, e.g. a vendor or protocol name plus what you want to know"),
});

export const confidentialPaymentInputSchema = z.object({
  amountTokens: z
    .number()
    .positive()
    .max(5)
    .describe("Amount in whole tokens to move on the devnet demo mint"),
  /**
   * Owner-controlled, never model-controlled. The arena overwrites whatever
   * arrives here with the owner's toggle before the handler runs, so a
   * prompt-injected agent cannot decide to publish an amount — the same
   * separation the spend policy enforces for limits.
   */
  mode: z.enum(["confidential", "public"]).optional(),
});

export const swapQuoteInputSchema = z.object({
  inputMint: z.string().trim().min(32).max(64).describe("Mint being sold"),
  outputMint: z.string().trim().min(32).max(64).describe("Mint being bought"),
  sol: z.number().positive().max(1_000_000).describe("Input amount in whole SOL"),
});

export const authorizeSpendInputSchema = z.object({
  amountTokens: z.number().positive().max(1_000_000_000).describe("Amount in whole tokens"),
  recipient: z.string().trim().min(32).max(64).describe("Recipient address"),
  reasoning: z
    .string()
    .trim()
    .min(1)
    .max(220)
    .describe("Why this spend is being made. Encrypted on-chain, owner-only."),
});

/**
 * Single source for how each tool is described to the model.
 *
 * `server/services/agent-graph.ts` builds its prompt from this rather than
 * keeping a parallel copy, so a description can no longer drift from the
 * implementation it describes.
 */
export const GRAPH_ACTION_DESCRIPTIONS: Record<AgentGraphToolName, string> = {
  get_wallet_overview:
    "Read the connected owner's local Agacy wallet and policy overview. Input must be {}. Read-only.",
  check_on_chain_policy:
    "Read the provisioned policy account from Solana devnet. Input must be {}. Read-only.",
  authorize_policy_spend:
    "Ask the deployed policy program to authorize a spend on devnet. Input: amountTokens, recipient, reasoning. This proves policy authorization only; it does not transfer tokens.",
  get_token_price:
    "Look up a token's real USD market price via Jupiter. Input: mint (token mint address). Read-only, no wallet needed.",
  get_swap_quote:
    "Get a real routed swap quote from Jupiter (mainnet market data, safe to call from any cluster). Input: inputMint, outputMint, sol (input amount). Read-only — does not execute anything.",
  cross_check_token_price:
    "Independently re-price a token through AIsa (CoinGecko aggregate) and compare it against the Jupiter figure, reporting how far apart the two sources are. Input: mint. Read-only. Use this before acting on a price, not instead of get_token_price.",
  pay_confidentially:
    "Execute a real Token-2022 confidential transfer on Solana devnet and verify the amount is not readable on-chain afterwards. Input: amountTokens (max 5). This moves tokens on a demo mint held by the server, not the owner's funds — use it to demonstrate that an amount becomes ciphertext, not to settle a real invoice.",
  research_counterparty:
    "Search the open web through AIsa for recent news about a vendor, token, protocol, or counterparty before acting on a payment decision. Input: query (a short search phrase). Read-only. Use it to surface anything an owner would want to know that the chain cannot tell you — an exploit, a rug, a depeg, an outage.",
};

/**
 * Build the graph's actions against a context.
 *
 * Called per execution rather than memoised: constructing five plain objects is
 * far cheaper than the RPC round-trips the handlers make, and a fresh build
 * cannot serve a stale policy or spend total to a later call.
 */
export function createGraphActions(context: GraphActionContext): Action[] {
  return [
    {
      name: "get_wallet_overview",
      similes: ["read my wallet", "check my balance", "what is my spend policy"],
      description: GRAPH_ACTION_DESCRIPTIONS.get_wallet_overview,
      examples: [[{
        input: {},
        output: { status: "succeeded", tool: "get_wallet_overview" },
        explanation: "Reads the owner address and configured spend policy before deciding anything.",
      }]],
      schema: emptyInputSchema,
      handler: async () => walletOverview(context),
    },
    {
      name: "check_on_chain_policy",
      similes: ["read the on-chain policy", "what does the program enforce"],
      description: GRAPH_ACTION_DESCRIPTIONS.check_on_chain_policy,
      examples: [[{
        input: {},
        output: { status: "succeeded", tool: "check_on_chain_policy" },
        explanation: "Reads the deployed policy account, which is what actually enforces the limit.",
      }]],
      schema: emptyInputSchema,
      handler: async () => readPolicy(context),
    },
    {
      name: "get_token_price",
      similes: ["price of a token", "how much is this token worth"],
      description: GRAPH_ACTION_DESCRIPTIONS.get_token_price,
      examples: [[{
        input: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
        output: { status: "succeeded", tool: "get_token_price" },
        explanation: "Looks up live market data before considering a purchase.",
      }]],
      schema: tokenPriceInputSchema,
      handler: async (_agent, input) => readTokenPrice(tokenPriceInputSchema.parse(input)),
    },
    {
      name: "cross_check_token_price",
      similes: ["verify the price", "second opinion on price", "is this price right"],
      description: GRAPH_ACTION_DESCRIPTIONS.cross_check_token_price,
      examples: [[{
        input: { mint: "So11111111111111111111111111111111111111112" },
        output: { status: "succeeded", tool: "cross_check_token_price" },
        explanation: "Re-prices the token through a second, independent source before money moves.",
      }]],
      schema: tokenPriceInputSchema,
      handler: async (_agent, input) => crossCheckTokenPrice(tokenPriceInputSchema.parse(input)),
    },
    {
      name: "research_counterparty",
      similes: ["search the web", "any recent news", "check this vendor", "due diligence"],
      description: GRAPH_ACTION_DESCRIPTIONS.research_counterparty,
      examples: [[{
        input: { query: "Solana token exploit this week" },
        output: { status: "succeeded", tool: "research_counterparty" },
        explanation: "Checks the open web for anything that should stop a payment before it is made.",
      }]],
      schema: researchInputSchema,
      handler: async (_agent, input) => researchCounterparty(researchInputSchema.parse(input)),
    },
    {
      name: "pay_confidentially",
      similes: ["pay privately", "send an encrypted payment", "prove the amount is hidden"],
      description: GRAPH_ACTION_DESCRIPTIONS.pay_confidentially,
      examples: [[{
        input: { amountTokens: 2 },
        output: { status: "succeeded", tool: "pay_confidentially" },
        explanation: "Moves value on devnet and then reads the recipient account back to prove the amount is ciphertext.",
      }]],
      schema: confidentialPaymentInputSchema,
      handler: async (_agent, input) =>
        runConfidentialPayment(context, confidentialPaymentInputSchema.parse(input)),
    },
    {
      name: "get_swap_quote",
      similes: ["quote a swap", "how much would I get for", "buy a token"],
      description: GRAPH_ACTION_DESCRIPTIONS.get_swap_quote,
      examples: [[{
        input: {
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
          sol: 1,
        },
        output: { status: "succeeded", tool: "get_swap_quote" },
        explanation: "Quotes a route without executing it; execution is mainnet-only.",
      }]],
      schema: swapQuoteInputSchema,
      handler: async (_agent, input) => readSwapQuote(swapQuoteInputSchema.parse(input)),
    },
    {
      name: "authorize_policy_spend",
      similes: ["authorize a payment", "check this spend against the policy"],
      description: GRAPH_ACTION_DESCRIPTIONS.authorize_policy_spend,
      examples: [[{
        input: {
          amountTokens: 5,
          recipient: "5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5",
          reasoning: "Monthly subscription renewal.",
        },
        output: { status: "succeeded", tool: "authorize_policy_spend" },
        explanation: "Asks the deployed program to authorize the spend. Refused on-chain if out of policy.",
      }]],
      schema: authorizeSpendInputSchema,
      handler: async (_agent, input) =>
        authorizeSpend(context, authorizeSpendInputSchema.parse(input)),
    },
  ];
}

/**
 * The same actions as an Agent Kit plugin, for a server-side runtime that wants
 * the real orchestration loop rather than the graph's tree expansion.
 */
export function createAgacyGraphPlugin(context: GraphActionContext): Plugin {
  return {
    name: "agacy-graph",
    methods: {},
    actions: createGraphActions(context),
    initialize() {
      // Dependencies arrive through GraphActionContext, so there is nothing to
      // pull off the agent at initialise time. See this file's header.
    },
  };
}

/** Narrower than `SolanaAgentKit` on purpose — see this file's header note 2. */
export type UnusedAgent = SolanaAgentKit;

function walletOverview(context: GraphActionContext): AuthorizedAgentGraphToolResultDTO {
  const policy = context.policy;
  return {
    tool: "get_wallet_overview",
    status: "succeeded",
    summary: policy
      ? `Owner ${context.ownerAddress}. Policy: ${formatTokens(policy.maxPerTransfer)} per transfer, ${formatTokens(policy.maxPerPeriod)} per period, ${formatTokens(context.spentThisPeriod)} recorded in this session.`
      : `Owner ${context.ownerAddress}. No local spend policy is configured yet.`,
    modelSummary: policy
      ? "The owner wallet overview was read successfully. A spend policy exists; identity and monetary values were withheld from the model."
      : "The owner wallet overview was read successfully. No spend policy is configured; identity was withheld from the model.",
  };
}

async function readPolicy(
  context: GraphActionContext,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  if (!context.policyAccount) {
    return blocked("check_on_chain_policy", "No policy account is provisioned.");
  }
  const policy = await fetchOnChainPolicyStatus(context.client, context.policyAccount);
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

/**
 * Prices the same mint through two independent sources and reports the gap.
 *
 * The point is not a nicer number. An agent that is about to spend money on a
 * single unverified quote has one point of failure between a stale or
 * manipulated feed and a payment. Jupiter aggregates Solana DEX routes; AIsa
 * fronts CoinGecko's cross-exchange aggregate. They can be wrong, but not
 * usually in the same direction at the same moment — so the divergence is the
 * signal, and it is reported even when it is small.
 *
 * A disagreement is returned as `refused`, not `failed`: nothing broke, the
 * sources simply do not agree well enough to act on, and the graph should
 * replan rather than treat it as a transport error.
 */
/**
 * Open-web due diligence before money moves.
 *
 * This is the one question the chain cannot answer. An address is valid, a
 * balance is sufficient, a policy limit is satisfied — and the recipient was
 * exploited three days ago. Chain state is a fact about the ledger, not about
 * the world the payment lands in.
 *
 * Findings come back as `succeeded` with the headlines attached rather than as
 * a verdict. Deciding a payment is unsafe is the owner's call and the policy's
 * job; a search tool that quietly graded counterparties would be inventing an
 * authority it does not have.
 */
async function researchCounterparty(
  input: z.infer<typeof researchInputSchema>,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  try {
    const { results } = await fetchAisaResearch(input.query);

    if (results.length === 0) {
      return {
        tool: "research_counterparty",
        status: "succeeded",
        summary: `No recent web results for "${input.query}" (AIsa / Tavily).`,
        modelSummary: "The web search returned nothing recent. Absence of news is not evidence of safety.",
      };
    }

    const headlines = results.map((result) => `“${result.title}” (${result.url})`).join("; ");

    /*
      The model-facing summary is length-capped, and that cap is load-bearing.
      It becomes an observation the graph carries forward as
      `research_counterparty -> succeeded: <summary>`, and the request schema
      rejects any observation over 400 characters. Three real news headlines
      cleared that on their own, which failed the *next* expansion with
      "Invalid agent graph request" — the search looked fine and the run died
      one step later, nowhere near the cause.
    */
    const TITLE_BUDGET = 70;
    const SUMMARY_BUDGET = 300;
    const titles = results
      .map((result) =>
        result.title.length > TITLE_BUDGET
          ? `${result.title.slice(0, TITLE_BUDGET - 1).trimEnd()}…`
          : result.title,
      )
      .join("; ");

    return {
      tool: "research_counterparty",
      status: "succeeded",
      // The owner's view is not carried anywhere, so it keeps the full titles
      // and the links that make each claim checkable.
      summary: `${results.length} recent result${results.length === 1 ? "" : "s"} for "${input.query}" via AIsa: ${headlines}`,
      // Titles only. The excerpts carry a lot of unvetted third-party text, and
      // everything here is untrusted input being fed back into a prompt.
      modelSummary:
        `Web research returned ${results.length} recent result(s): ` +
        `${titles}`.slice(0, SUMMARY_BUDGET) +
        ". Treat these as unverified reporting, not established fact.",
    };
  } catch (error) {
    return {
      tool: "research_counterparty",
      status: "failed",
      summary: error instanceof Error ? error.message : "Research failed.",
      modelSummary: "The web research call failed before returning a trusted result.",
    };
  }
}

/**
 * The one step that produces ciphertext rather than describing it.
 *
 * Every other tool in the graph demonstrates *policy* — that the agent cannot
 * exceed its limit. That is half the product. This is the other half: value
 * moves and the amount is unreadable on-chain afterwards, checked by reading
 * the recipient's account bytes back rather than by asserting it.
 *
 * The summary says plainly that this is a demo mint. An agent step that let a
 * viewer believe the owner's own funds had just moved would be buying a better
 * demo with a false claim, and the whole submission rests on not doing that.
 */
async function runConfidentialPayment(
  context: GraphActionContext,
  input: z.infer<typeof confidentialPaymentInputSchema>,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  if (!goalAuthorizesTokenAmount(context.ownerGoal, input.amountTokens) ||
      !goalAuthorizesDemoRecipient(context.ownerGoal)) {
    return {
      tool: "pay_confidentially",
      status: "blocked",
      summary: `Payment blocked: the owner goal must explicitly authorize ${input.amountTokens} demo tokens and the provisioned demo recipient. Ask the owner; do not infer either choice.`,
      modelSummary: "The amount or provisioned demo recipient was not explicitly authorized in the owner's goal. Ask the owner; do not guess.",
    };
  }

  const mode = input.mode ?? "confidential";
  try {
    const receipt = await payConfidentially(input.amountTokens, mode);

    // In confidential mode a readable amount is a failed privacy claim, not a
    // successful payment. In public mode a readable amount is the entire point,
    // so the guard is scoped rather than global.
    if (mode === "confidential" && receipt.amountReadableOnChain) {
      return {
        tool: "pay_confidentially",
        status: "failed",
        summary: `Transfer ${receipt.signature} landed, but the amount WAS readable in the recipient's account data. The confidentiality claim did not hold.`,
        modelSummary: "The transfer completed but failed its confidentiality check. Do not treat the amount as private.",
        signature: receipt.signature,
      };
    }

    const seconds = (receipt.elapsedMs / 1000).toFixed(1);
    return {
      tool: "pay_confidentially",
      status: "succeeded",
      summary: mode === "public"
        ? `Paid ${input.amountTokens} tokens as an ordinary SPL transfer in ${seconds}s. ` +
          `The amount IS readable in the recipient's account data — anyone can read it on Solana Explorer. ` +
          `Demo mint ${receipt.mint}, not owner funds. Signature: ${receipt.signature}`
        : `Moved ${input.amountTokens} tokens confidentially on devnet in ${seconds}s. ` +
          `The amount is NOT readable in the recipient's account data. Demo mint ${receipt.mint}, not owner funds. ` +
          `Signature: ${receipt.signature}`,
      modelSummary: mode === "public"
        ? "An ordinary public transfer completed on devnet. The amount is visible on-chain to anyone. This used a demo mint, not the owner's funds."
        : "A confidential transfer completed on devnet and the amount was verified unreadable on-chain. This used a demo mint, not the owner's funds. Exact values and addresses were withheld.",
      signature: receipt.signature,
      paymentAccounting: receipt.accounting,
    };
  } catch (error) {
    return {
      tool: "pay_confidentially",
      status: "failed",
      summary: error instanceof Error ? error.message : "Confidential transfer failed.",
      modelSummary: "The confidential transfer failed before producing a trusted result.",
    };
  }
}

async function crossCheckTokenPrice(
  input: z.infer<typeof tokenPriceInputSchema>,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  // 2% is a judgement call, not a derived threshold: wide enough to absorb the
  // spread between a DEX router and a spot aggregate, tight enough that a feed
  // genuinely out of step still trips it.
  const DIVERGENCE_LIMIT_PERCENT = 2;

  try {
    const [jupiter, aisa] = await Promise.all([
      fetchTokenPrice(input.mint),
      fetchAisaTokenPrice(input.mint),
    ]);

    if (jupiter.priceUsd === null || aisa.priceUsd === null) {
      const missing = jupiter.priceUsd === null ? "Jupiter" : "AIsa";
      return {
        tool: "cross_check_token_price",
        status: "refused",
        summary: `${missing} returned no price for ${input.mint}, so the two sources could not be compared.`,
        modelSummary: "Only one of the two price sources answered, so the price is unconfirmed. Do not act on it.",
      };
    }

    const divergence = priceDivergencePercent(jupiter.priceUsd, aisa.priceUsd);
    const agreed = divergence <= DIVERGENCE_LIMIT_PERCENT;
    const figures =
      `Jupiter $${jupiter.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })} vs ` +
      `AIsa/CoinGecko $${aisa.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })} ` +
      `(${divergence.toFixed(2)}% apart)`;

    return {
      tool: "cross_check_token_price",
      status: agreed ? "succeeded" : "refused",
      summary: agreed
        ? `Two independent sources agree on ${input.mint}: ${figures}.`
        : `Sources disagree on ${input.mint}: ${figures}, above the ${DIVERGENCE_LIMIT_PERCENT}% tolerance.`,
      // Percentages are safe to hand back; the prices themselves are owner detail.
      modelSummary: agreed
        ? `Two independent price sources agreed within ${divergence.toFixed(2)}%. The price is corroborated.`
        : `Two independent price sources disagreed by ${divergence.toFixed(2)}%, beyond the ${DIVERGENCE_LIMIT_PERCENT}% tolerance. Treat the price as unreliable and do not act on it.`,
    };
  } catch (error) {
    return {
      tool: "cross_check_token_price",
      status: "failed",
      summary: error instanceof Error ? error.message : "Cross-check failed.",
      modelSummary: "The independent price cross-check failed before returning a trusted result.",
    };
  }
}

async function readTokenPrice(
  input: z.infer<typeof tokenPriceInputSchema>,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  try {
    const { priceUsd } = await fetchTokenPrice(input.mint);
    return {
      tool: "get_token_price",
      status: "succeeded",
      summary: priceUsd === null
        ? `No live Jupiter price found for ${input.mint}.`
        : `${input.mint}: $${priceUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })} USD (Jupiter, mainnet market data).`,
      modelSummary: priceUsd === null
        ? "No price was found for that mint."
        : `Price found: $${priceUsd}. This is market data only — no funds moved.`,
    };
  } catch (error) {
    return {
      tool: "get_token_price",
      status: "failed",
      summary: error instanceof Error ? error.message : "Price lookup failed.",
      modelSummary: "The price lookup failed before returning a trusted result.",
    };
  }
}

async function readSwapQuote(
  input: z.infer<typeof swapQuoteInputSchema>,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  try {
    const quote = await fetchSwapQuote({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amountLamports: BigInt(Math.round(input.sol * LAMPORTS_PER_SOL)),
    });
    return {
      tool: "get_swap_quote",
      status: "succeeded",
      summary:
        `Quote: ${input.sol} SOL in -> ${quote.outAmount} base units of ${input.outputMint} out ` +
        `(price impact ${quote.priceImpactPct ?? "unknown"}%). Jupiter mainnet route — nothing executed. ` +
        `Executing a real swap needs a mainnet run (npm run agent:mainnet); it is not available in this session.`,
      modelSummary:
        `A swap quote was found: ${input.sol} SOL for approximately ${quote.outAmount} base units of the ` +
        "output token. This is a quote only — execution is mainnet-only and out of scope here.",
    };
  } catch (error) {
    return {
      tool: "get_swap_quote",
      status: "failed",
      summary: error instanceof Error ? error.message : "Swap quote failed.",
      modelSummary: "The swap quote failed before returning a trusted result.",
    };
  }
}

async function authorizeSpend(
  context: GraphActionContext,
  input: z.infer<typeof authorizeSpendInputSchema>,
): Promise<AuthorizedAgentGraphToolResultDTO> {
  if (!context.policy || !context.policyAccount) {
    return blocked("authorize_policy_spend", "Create an agent policy before requesting authorization.");
  }
  const recipientAuthorized = context.ownerGoal.includes(input.recipient) ||
    context.policy.allowedRecipients.includes(input.recipient);
  if (!recipientAuthorized || !mentionsAmount(context.ownerGoal, input.amountTokens)) {
    return blocked(
      "authorize_policy_spend",
      "The owner mandate must explicitly identify the amount and must name the recipient unless that recipient is already on the policy allow-list.",
    );
  }
  if (!context.agentSigner) {
    return blocked(
      "authorize_policy_spend",
      "The session signing key is unavailable. Recreate the agent in this tab to restore autonomous signing.",
    );
  }

  const amount = BigInt(Math.round(input.amountTokens * TOKEN_SCALE));
  const onChainPolicy = await fetchOnChainPolicyStatus(context.client, context.policyAccount);
  if (!onChainPolicy) return blocked("authorize_policy_spend", "The policy account was not found on devnet.");

  const verdict = evaluateSpendPolicy(
    {
      action: "transfer",
      reasoning: input.reasoning,
      proposedAmount: amount,
      recipient: input.recipient,
    },
    {
      policy: context.policy,
      spentThisPeriod: onChainPolicy.spentInPeriod,
      availableBalance: context.policy.maxPerPeriod,
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
    client: context.client,
    policyAccount: address(context.policyAccount),
    agentSigner: context.agentSigner,
    goal: "Authorize one owner-command spend against the deployed policy.",
    tasks: [{
      label: "Owner-command authorization",
      reasoning: input.reasoning,
      amount,
      recipient: input.recipient,
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

export function goalAuthorizesTokenAmount(goal: string, amount: number): boolean {
  return [...goal.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(?:-\s*)?tokens?\b/gi)].some((match) =>
    Math.abs(Number(match[1]?.replace(",", ".")) - amount) < Number.EPSILON);
}

function goalAuthorizesDemoRecipient(goal: string): boolean {
  return /\b(?:provisioned|demo)\b.*\b(?:recipient|vendor|wallet)\b/i.test(goal);
}

function blocked(
  tool: AgentGraphToolName,
  summary: string,
): AuthorizedAgentGraphToolResultDTO {
  return {
    tool,
    status: "blocked",
    summary,
    modelSummary: "The requested tool is unavailable in the current owner session.",
  };
}
