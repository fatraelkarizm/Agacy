import { evaluateSpendPolicy } from "../server/services/spend-policy.js";
import type { AgacyTool, ToolContext } from "./tools/toolkit.js";

/**
 * Central enforcement point between the model and anything that moves money.
 *
 * The reason this is a wrapper rather than a check inside each tool: an LLM
 * choosing its own tools means the *set* of things it can do is open-ended, so
 * "remember to check the policy" is exactly the kind of rule that gets skipped
 * by the next tool someone adds. Here, a tool declaring `spendAmount` is
 * automatically gated, and a tool that forgets to declare it is caught by
 * `assertToolsDeclareSpend` below rather than silently spending.
 *
 * Refusals are returned as tool results, not thrown. The agent should be able
 * to see "that was over the limit" and reason about an alternative — an
 * exception would just end the run and teach it nothing.
 */

export interface GuardedRun {
  /** Accumulated spend for this run, in payment-token base units. */
  spentThisPeriod: bigint;
  readonly refusals: string[];
  readonly spends: { tool: string; amount: bigint }[];
}

/**
 * A tool with its execution context already bound. Distinct from `AgacyTool`
 * on purpose: once guarded, a tool can no longer be handed a context by its
 * caller, which is what stops a caller from quietly supplying a permissive one.
 */
export interface GuardedTool {
  readonly name: string;
  readonly description: string;
  readonly schema: AgacyTool["schema"];
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface PolicyGuardOptions {
  readonly tools: readonly AgacyTool[];
  readonly baseContext: Omit<ToolContext, "spentThisPeriod">;
  readonly run: GuardedRun;
  readonly onToolCall?: (event: {
    tool: string;
    input: unknown;
    outcome: "allowed" | "refused";
    reason?: string;
  }) => void;
}

/**
 * Wrap every tool so value-moving calls pass the spend policy first.
 * Read-only tools are passed through untouched.
 */
export function guardTools(options: PolicyGuardOptions): readonly GuardedTool[] {
  const { tools, baseContext, run, onToolCall } = options;

  // Shared across every spend-gated tool returned below, so their *effects*
  // (not just the policy bookkeeping above) run strictly one at a time for
  // this whole run. This matters independently of the reservation race: a
  // confidential transfer reads the account's current on-chain ciphertext
  // and builds a proof against it, so two transfers from the same account
  // racing each other would build proofs against the same pre-transfer
  // state and one would fail on-chain once the other lands first. Read-only
  // tools are unaffected — they never touch this chain.
  let executionChain: Promise<void> = Promise.resolve();

  return tools.map((tool): GuardedTool => {
    const contextFor = (): ToolContext => ({ ...baseContext, spentThisPeriod: run.spentThisPeriod });

    if (tool.spendAmount === null) {
      return {
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
        execute: async (input) => {
          onToolCall?.({ tool: tool.name, input, outcome: "allowed" });
          return tool.execute(input as never, contextFor());
        },
      };
    }

    const spendAmount = tool.spendAmount;
    return {
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      execute: async (input) => {
        let amount: bigint;
        try {
          amount = spendAmount(input as Record<string, never>);
        } catch (error) {
          const reason = `Could not read a spend amount from the request: ${
            error instanceof Error ? error.message : String(error)
          }`;
          run.refusals.push(reason);
          onToolCall?.({ tool: tool.name, input, outcome: "refused", reason });
          return { status: "refused", reason };
        }

        const context = contextFor();
        const verdict = evaluateSpendPolicy(
          {
            action: "transfer",
            reasoning: `tool:${tool.name}`,
            proposedAmount: amount,
            recipient: readRecipient(input),
          },
          {
            policy: context.policy,
            spentThisPeriod: context.spentThisPeriod,
            availableBalance: context.availableBalance,
          },
        );

        if (!verdict.compliant) {
          run.refusals.push(verdict.reason);
          onToolCall?.({ tool: tool.name, input, outcome: "refused", reason: verdict.reason });
          return { status: "refused", reason: verdict.reason };
        }

        // Reserved *synchronously*, before the `await` below, not after
        // execute() resolves. A model can request several tool calls in one
        // step, which run concurrently — if the reservation happened after
        // the async effect, every concurrent call would read the same
        // pre-spend total and all pass the check together, blowing straight
        // through the period limit as a group even though each looked
        // individually compliant. Node never interleaves two calls' synchronous
        // code, so as long as nothing here awaits before this line, this
        // check-then-reserve pair is atomic regardless of how many calls the
        // model fires at once.
        run.spentThisPeriod += amount;
        run.spends.push({ tool: tool.name, amount });
        onToolCall?.({ tool: tool.name, input, outcome: "allowed" });

        // Queued onto the shared chain rather than awaited directly: this
        // call's turn only starts once every earlier spend-gated call in
        // this run has finished, regardless of how many the model fired at
        // once. If this throws (e.g. an RPC error after a transaction was
        // already submitted), it's unknown whether the effect partially
        // landed — the reservation above deliberately stays in place rather
        // than risk under-counting a real spend, and the error propagates.
        const runThisCall = executionChain.then(() => tool.execute(input as never, context));
        executionChain = runThisCall.then(
          () => undefined,
          () => undefined, // a failed call must not jam the queue for calls after it
        );
        const result = await runThisCall;

        // The tool consciously did nothing (e.g. "this needs a different
        // cluster") — release the reservation, since we know for certain
        // nothing moved. Anything else, including silence, keeps it reserved.
        if (!didSpend(result)) {
          run.spentThisPeriod -= amount;
          run.spends.pop();
        }
        return result;
      },
    };
  });
}

/**
 * A tool result counts as spend unless it explicitly says otherwise. Tools
 * that decline for reasons other than policy (see pay_vendor_confidentially's
 * cluster check in tools/toolkit.ts) return `status: "unavailable"`, which is
 * the one convention this guard trusts to mean "nothing moved" — anything
 * else, including no `status` field at all, is treated as a real spend.
 */
function didSpend(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return true;
  return (result as { status?: unknown }).status !== "unavailable";
}

function readRecipient(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const recipient = (input as { recipient?: unknown }).recipient;
  return typeof recipient === "string" ? recipient : undefined;
}

/**
 * Catches the failure mode this whole module exists to prevent: a tool whose
 * name says it moves money but which declares itself read-only. Run as a test
 * rather than at startup so it fails during development, not in front of a user.
 */
const VALUE_MOVING_NAME = /(pay|send|transfer|swap|withdraw|buy|sell|stake|burn|mint)/i;
/** Tools whose names match but which genuinely move nothing, with the reason they are exempt. */
const READ_ONLY_EXCEPTIONS: Record<string, string> = {
  get_swap_quote: "returns a quote only; executes nothing",
  swap_tokens: "denominated in SOL, capped by the mainnet SOL ceiling instead of the token policy",
};

export function assertToolsDeclareSpend(tools: readonly AgacyTool[]): void {
  const undeclared = tools.filter(
    (tool) =>
      tool.spendAmount === null &&
      VALUE_MOVING_NAME.test(tool.name) &&
      !(tool.name in READ_ONLY_EXCEPTIONS),
  );

  if (undeclared.length > 0) {
    throw new Error(
      `These tools look like they move value but declare spendAmount: null — ` +
        `either declare the amount or add an explicit exemption with a reason: ` +
        undeclared.map((tool) => tool.name).join(", "),
    );
  }
}
