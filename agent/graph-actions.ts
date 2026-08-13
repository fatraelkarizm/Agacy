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
