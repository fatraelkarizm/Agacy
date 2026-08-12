import type { AgentExecutionDTO } from "../dto/agent.dto";
import type { AuthorizedTransactionDTO, PublicTransactionDTO } from "../dto/transaction.dto";
import { toPublicView } from "../dto/transaction.dto";

/**
 * Scenario data for the side-by-side demo.
 *
 * Kept in the service layer rather than inside a component so the comparison is
 * driven by the same DTO boundary the real product uses: the "public" column is
 * literally produced by `toPublicView`, not hand-written to look redacted.
 */

export interface ExposedTransactionDTO {
  readonly signature: string;
  readonly timestamp: number;
  readonly status: "confirmed";
  /** Visible to anyone with a block explorer — this is the point being made. */
  readonly amount: bigint;
  readonly counterparty: string;
  readonly resultingBalance: bigint;
}

export interface ScenarioStep {
  readonly label: string;
  readonly reasoning: string;
  readonly amount: bigint;
  readonly counterparty: string;
}

/** A week in the life of an agent managing a stablecoin budget. */
export const SCENARIO: readonly ScenarioStep[] = [
  {
    label: "Subscription renewal",
    reasoning: "Monthly API subscription came due; renewed at the standard rate.",
    amount: 4_200_000n,
    counterparty: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK",
  },
  {
    label: "Compute top-up",
    reasoning: "Inference credits were running low; bought a top-up before the queue stalled.",
    amount: 12_500_000n,
    counterparty: "Cmp7yTn2WxLqE9vRb4sKfJ6hGpZa3MdUc8NrVwXt",
  },
  {
    label: "Data purchase",
    reasoning: "Bought the market dataset the weekly report depends on.",
    amount: 31_750_000n,
    counterparty: "Dta9mKpR5nZwQ2eXcVb7yLsHfG4jTaU6dNrMwPkB",
  },
];

const STARTING_BALANCE = 250_000_000n;

export interface ScenarioResult {
  readonly exposed: readonly ExposedTransactionDTO[];
  readonly publicView: readonly PublicTransactionDTO[];
  readonly authorized: readonly AuthorizedTransactionDTO[];
}

/**
 * Run the scenario twice over identical activity: once on ordinary public
 * rails, once through Agacy. The transactions are the same; only what an
 * observer can read differs.
 */
export function runScenario(steps: readonly ScenarioStep[] = SCENARIO): ScenarioResult {
  const exposed: ExposedTransactionDTO[] = [];
  const authorized: AuthorizedTransactionDTO[] = [];

  let balance = STARTING_BALANCE;
  let timestamp = Date.UTC(2026, 7, 2, 9, 15);

  for (const [index, step] of steps.entries()) {
    balance -= step.amount;
    timestamp += 86_400_000;

    exposed.push({
      signature: fakeSignature(index, "public"),
      timestamp,
      status: "confirmed",
      amount: step.amount,
      counterparty: step.counterparty,
      resultingBalance: balance,
    });

    authorized.push({
      signature: fakeSignature(index, "confidential"),
      timestamp,
      status: "confirmed",
      confidential: true,
      amount: step.amount,
      counterparty: step.counterparty,
      resultingBalance: balance,
      agentReasoning: step.reasoning,
    });
  }

  return {
    exposed,
    // The public column is derived through the real DTO boundary, so it cannot
    // show a field the production public view would not have.
    publicView: authorized.map(toPublicView),
    authorized,
  };
}

/**
 * Maps the live local agent trace into the same owner-only DTO used by transaction views.
 *
 * Uses the execution's real devnet `authorize` signature when the run produced one, so
 * anything shown in the dashboard can be pasted into an explorer and actually resolve.
 * `fakeSignature` is a fallback only for callers that never touched a chain (e.g. the
 * static `runScenario` walkthrough), not a substitute for a signature that exists.
 */
export function buildAuthorizedDemoHistory(
  executions: readonly AgentExecutionDTO[],
  startingBalance = STARTING_BALANCE,
): AuthorizedTransactionDTO[] {
  let balance = startingBalance;
  const firstTimestamp = Date.UTC(2026, 7, 2, 9, 15);

  return executions.map((execution, index) => {
    balance -= execution.amount;
    return {
      signature: execution.signature ?? fakeSignature(index, "runtime"),
      timestamp: firstTimestamp + index * 60_000,
      status: "confirmed",
      confidential: true,
      amount: execution.amount,
      counterparty: execution.recipient,
      resultingBalance: balance,
      agentReasoning: execution.reasoning,
    };
  });
}

/**
 * Deterministic placeholder signatures. Real ones come from devnet; these keep
 * the demo stable and reproducible when running without a chain connection.
 */
function fakeSignature(index: number, kind: string): string {
  const seed = `${kind}${index}`;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  let value = hash;
  for (let i = 0; i < 44; i++) {
    value = (value * 1_103_515_245 + 12_345) >>> 0;
    out += alphabet[value % alphabet.length];
  }
  return out;
}

/** Render a ciphertext-looking blob for a value, for display only. */
export function ciphertextPreview(amount: bigint, salt: number): string {
  const hexAlphabet = "0123456789abcdef";
  let value = Number(amount % 1_000_000n) + salt * 7919;
  let out = "";
  for (let i = 0; i < 64; i++) {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    out += hexAlphabet[value % 16];
  }
  return out;
}

/**
 * A scripted attacker log for the "why does this matter" demo moment.
 *
 * The wallet-drainer research behind this product (docs/references/02-) found
 * that attackers preferentially target wallets whose balance they can see —
 * a visible balance is what makes a wallet worth attacking in the first
 * place. This turns that abstract point into a concrete, narrated sequence:
 * the same scan succeeds against the exposed wallet and fails against the
 * confidential one, using the *actual* numbers from the live agent run
 * rather than a canned example.
 */
export interface AttackStepDTO {
  readonly id: string;
  readonly target: "exposed" | "confidential";
  readonly narrative: string;
  readonly outcome: "revealed" | "blocked";
  readonly detail: string;
}

/**
 * Same mechanism, two audiences. A personal wallet is sized up by an
 * attacker deciding whether it's worth draining; a business's procurement
 * wallet is read by a competitor inferring supplier relationships and spend.
 * The privacy property being demonstrated doesn't change — only who's
 * watching and what they're after does, which is why this is a wording
 * table rather than a second implementation (see FEATURES.md item 8: this
 * is presentation-layer only, no new on-chain logic).
 */
export type AttackFraming = "personal" | "business";

const ATTACKER_LABEL: Record<AttackFraming, string> = {
  personal: "Attacker",
  business: "Competitor",
};

export function buildAttackSimulation(
  executed: readonly AgentExecutionDTO[],
  balance: bigint,
  framing: AttackFraming = "personal",
): readonly AttackStepDTO[] {
  if (executed.length === 0) return [];

  const last = executed[executed.length - 1]!;
  const who = ATTACKER_LABEL[framing];

  return [
    {
      id: "scan-exposed",
      target: "exposed",
      narrative:
        framing === "business"
          ? `${who} pulls this business wallet's transaction history from a public block explorer.`
          : `${who} pulls this wallet's transaction history from a public block explorer.`,
      outcome: "revealed",
      detail:
        framing === "business"
          ? `Reads every payment directly: last supplier payment ${formatTokens(last.amount)} USDC to ${last.recipient.slice(0, 10)}… — a name and a number, not just a transaction.`
          : `Reads every transfer directly: last payment ${formatTokens(last.amount)} USDC to ${last.recipient.slice(0, 10)}…`,
    },
    {
      id: "size-exposed",
      target: "exposed",
      narrative:
        framing === "business"
          ? `${who} totals recent outflows to estimate procurement spend and infer revenue.`
          : `${who} checks the current balance to decide if this wallet is worth targeting.`,
      outcome: "revealed",
      detail:
        framing === "business"
          ? `Balance and payment history read as plain data: ${formatTokens(balance)} USDC. Enough to model your cost structure.`
          : `Balance reads as plain data: ${formatTokens(balance)} USDC. Flagged as a live target.`,
    },
    {
      id: "scan-confidential",
      target: "confidential",
      narrative: `${who} runs the identical scan against the Agacy-protected wallet.`,
      outcome: "blocked",
      detail: "Transaction is confirmed and public, but amount and counterparty balance fields decode to ciphertext, not a number.",
    },
    {
      id: "size-confidential",
      target: "confidential",
      narrative:
        framing === "business"
          ? `${who} attempts the same spend/supplier analysis against the confidential wallet.`
          : `${who} attempts to size the wallet the same way before deciding whether to pursue it.`,
      outcome: "blocked",
      detail:
        framing === "business"
          ? "No plaintext balance or payment amount exists anywhere on-chain to read. There is no spend pattern to reconstruct."
          : "No plaintext balance exists anywhere on-chain to read. There is nothing to size.",
    },
  ];
}

export function formatTokens(baseUnits: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const fraction = (baseUnits % divisor).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${fraction}`;
}
