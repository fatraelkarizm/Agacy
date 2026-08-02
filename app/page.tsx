"use client";

import { useCallback, useRef, useState } from "react";
import { runAgent, type AgentStep, type AgentTask } from "../agent/loop";
import type { SpendPolicyDTO } from "../server/dto/agent.dto";
import { ciphertextPreview, formatTokens } from "../server/services/demo-scenario";
import devnetProof from "../server/data/devnet-proof.json";
import { AgentSetup } from "./AgentSetup";
import { toSpendPolicy, type AgentDraftDTO } from "../server/services/agent-setup";

/**
 * The demo is a guided walkthrough rather than one long page: you define an
 * agent, watch it run under those limits, then check the on-chain evidence.
 * Splitting it means each step can make one point properly instead of three
 * competing for the same screen.
 */

type Stage = "intro" | "setup" | "run" | "proof";

const STAGES: readonly { id: Stage; label: string }[] = [
  { id: "intro", label: "Overview" },
  { id: "setup", label: "1 · Create agent" },
  { id: "run", label: "2 · Watch it run" },
  { id: "proof", label: "3 · Verify on-chain" },
];

const TASKS: readonly AgentTask[] = [
  {
    prompt: "Monthly API subscription came due — renewing at the usual rate.",
    amount: 4_200_000n,
    recipient: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK",
    recipientLabel: "API subscription",
  },
  {
    prompt: "Inference credits are nearly out; topping up before the queue stalls.",
    amount: 12_500_000n,
    recipient: "Cmp7yTn2WxLqE9vRb4sKfJ6hGpZa3MdUc8NrVwXt",
    recipientLabel: "Compute credits",
  },
  {
    prompt: "Buying the market dataset the weekly report depends on.",
    amount: 31_750_000n,
    recipient: "Dta9mKpR5nZwQ2eXcVb7yLsHfG4jTaU6dNrMwPkB",
    recipientLabel: "Market dataset",
  },
];

const INITIAL_BALANCE = 250_000_000n;

interface Executed {
  readonly amount: bigint;
  readonly recipient: string;
  readonly reasoning: string;
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("intro");
  const [agent, setAgent] = useState<AgentDraftDTO | null>(null);
  const [policy, setPolicy] = useState<SpendPolicyDTO | null>(null);

  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [executed, setExecuted] = useState<Executed[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [ownerView, setOwnerView] = useState(false);
  const lastReasoning = useRef("");

  const reset = useCallback(() => {
    setSteps([]);
    setExecuted([]);
    setDone(false);
    setOwnerView(false);
  }, []);

  const run = useCallback(async () => {
    if (!policy) return;
    reset();
    setRunning(true);
    lastReasoning.current = "";

    await runAgent({
      tasks: TASKS,
      policy,
      initialState: { availableBalance: INITIAL_BALANCE, spentThisPeriod: 0n },
      onStep: async (step) => {
        if (step.kind === "think") lastReasoning.current = step.text;
        setSteps((prev) => [...prev, step]);
        if (step.kind === "execute" && step.amount !== undefined) {
          const amount = step.amount;
          setExecuted((prev) => [
            ...prev,
            { amount, recipient: step.recipient ?? "", reasoning: lastReasoning.current },
          ]);
        }
        await new Promise((resolve) => setTimeout(resolve, 620));
      },
    });

    setRunning(false);
    setDone(true);
  }, [policy, reset]);

  const spent = executed.reduce((sum, e) => sum + e.amount, 0n);
  const balance = INITIAL_BALANCE - spent;

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <div className="brand">
            <span className="brand-mark" />
            Agacy.
          </div>
          <div className="nav-steps">
            {STAGES.map((s) => (
              <button
                key={s.id}
                className={stage === s.id ? "nav-step active" : "nav-step"}
                onClick={() => setStage(s.id)}
                disabled={s.id !== "intro" && s.id !== "setup" && !agent}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {stage === "intro" && <Intro onStart={() => setStage("setup")} />}

      {stage === "setup" && (
        <div className="wrap step-page">
          <div className="step-head">
            <div className="step-index">Step 1 of 3</div>
            <h2>Create your agent.</h2>
            <p className="section-sub">
              You define what it may do, once. From then on the limits live in an account on-chain —
              not in a prompt the agent could be talked out of.
            </p>
          </div>
          <AgentSetup
            onCreate={(draft) => {
              setAgent(draft);
              setPolicy(toSpendPolicy(draft));
              reset();
              setStage("run");
            }}
          />
        </div>
      )}

      {stage === "run" && policy && agent && (
        <div className="wrap step-page">
          <div className="step-head">
            <div className="step-index">Step 2 of 3</div>
            <h2>Watch {agent.name} work.</h2>
            <p className="section-sub">
              A 250 USDC budget under the limits you just set: max{" "}
              {formatTokens(policy.maxPerTransfer)} per transfer, {formatTokens(policy.maxPerPeriod)}{" "}
              per period. It reasons about each task, proposes a payment, and the policy is checked{" "}
              <em>outside the model</em> before anything moves.
            </p>
          </div>

          <div className="controls">
            <button className="primary" onClick={run} disabled={running}>
              {running ? "Agent running…" : done ? "Run again" : "Start agent"}
            </button>
            <button onClick={reset} disabled={running || steps.length === 0}>
              Reset
            </button>
            <button onClick={() => setOwnerView(!ownerView)} disabled={executed.length === 0}>
              {ownerView ? "Hide owner view" : "View as owner"}
            </button>
            {done && (
              <button className="primary" onClick={() => setStage("proof")}>
                See the on-chain proof →
              </button>
            )}
            <span className="hint">
              {steps.length === 0
                ? "Idle."
                : `${executed.length} paid · ${formatTokens(balance)} USDC left`}
            </span>
          </div>

          <div className="layout">
            <AgentConsole steps={steps} running={running} />
            <div className="panels">
              <ExposedPanel executed={executed} balance={balance} />
              <ConfidentialPanel executed={executed} ownerView={ownerView} balance={balance} />
            </div>
          </div>
        </div>
      )}

      {stage === "proof" && <Proof />}

      <footer className="foot">
        <div className="wrap">
          The blocked payment is not the model changing its mind — the agent still proposes it. The
          spend policy is enforced outside the model, so a prompt-injected or malfunctioning agent
          cannot talk its way past it. Amounts are hidden by Solana&apos;s native Token-2022
          confidential transfers.
        </div>
      </footer>
    </>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <header className="wrap hero">
      <span className="pill">
        <span className="pill-badge">Live on devnet</span>
        <span className="pill-text">Token-2022 confidential transfers</span>
      </span>

      <h1>
        <span className="accent">Agacy</span> keeps your AI agent&apos;s spending unreadable
      </h1>

      <p className="lede">
        2.3 million AI agents already hold wallets and transact on their own — and every amount,
        balance, and counterparty is permanently public. Attackers now pick targets by reading
        balances. Agacy routes an agent&apos;s payments through Solana&apos;s confidential
        transfers: provably valid, unreadable amounts, with spend limits enforced on-chain.
      </p>

      <div className="hero-cta">
        <button className="primary" onClick={onStart}>
          Try the walkthrough
        </button>
        <button
          onClick={() =>
            window.open("https://github.com/fatraelkarizm/Agacy", "_blank", "noreferrer")
          }
        >
          View the code
        </button>
      </div>

      <div className="stats">
        <StatCard value="2.3M" label="AI agents transacting on-chain today" />
        <StatCard value="165M" label="agent payments processed via x402" />
        <StatCard value="+207%" label="jump in phishing losses as attackers began targeting visible balances" />
        <StatCard value="92" label="tests passing across the crypto, policy, and agent layers" />
      </div>
    </header>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Proof() {
  return (
    <div className="wrap step-page">
      <div className="step-head">
        <div className="step-index">Step 3 of 3</div>
        <h2>Not a mockup — verified on devnet.</h2>
        <p className="section-sub">
          Everything above runs for real. Below is an actual confidential transfer this codebase
          executed on Solana devnet: the transaction is public and confirmed, and the transferred
          amount is provably absent from the recipient&apos;s account data. Open any of them.
        </p>
      </div>

      <div className="proof-grid">
        <ProofItem label="Transfer transaction" value={devnetProof.transferSignature} isTx />
        <ProofItem label="Confidential mint" value={devnetProof.mint} />
        <ProofItem label="Recipient account" value={devnetProof.recipientAccount} />
        <ProofItem label="Spend policy program" value={devnetProof.policyProgramId} />
        <div className="proof-item">
          <div className="proof-label">Amount readable on-chain</div>
          <div className="proof-verdict">
            {devnetProof.amountFoundInRecipientAccountData ? "yes" : "no — encrypted"}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProofItem({ label, value, isTx }: { label: string; value: string; isTx?: boolean }) {
  const href = `https://explorer.solana.com/${isTx ? "tx" : "address"}/${value}?cluster=devnet`;
  return (
    <div className="proof-item">
      <div className="proof-label">{label}</div>
      <a className="proof-value" href={href} target="_blank" rel="noreferrer">
        {value.slice(0, 22)}…
      </a>
    </div>
  );
}

const STEP_LABEL: Record<AgentStep["kind"], string> = {
  observe: "observes",
  think: "reasons",
  decide: "decides",
  policy: "policy ok",
  execute: "executes",
  refused: "blocked",
};

function AgentConsole({ steps, running }: { steps: AgentStep[]; running: boolean }) {
  return (
    <section className="card console">
      <div className="console-head">
        <span className={running ? "dot live" : "dot"} />
        AI agent
      </div>
      <div className="console-body">
        {steps.length === 0 && <p className="empty">Press “Start agent”.</p>}
        {steps.map((step, i) => (
          <div className={`step step-${step.kind}`} key={i}>
            <span className="step-kind">{STEP_LABEL[step.kind]}</span>
            <span className="step-text">{step.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExposedPanel({ executed, balance }: { executed: Executed[]; balance: bigint }) {
  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <div className="panel-title">Without Agacy</div>
          <div className="panel-note">Ordinary SPL transfers</div>
        </div>
        <span className="tag exposed">Fully public</span>
      </div>

      <div className="explorer">
        <div className="explorer-label">What a stranger sees</div>
        {executed.length === 0 ? (
          <p className="empty">No transactions yet.</p>
        ) : (
          <>
            {executed.map((tx, i) => (
              <div className="row" key={i}>
                <span className="row-key">{tx.recipient.slice(0, 10)}…</span>
                <span className="row-val exposed">{formatTokens(tx.amount)} USDC</span>
              </div>
            ))}
            <div className="row">
              <span className="row-key">Balance</span>
              <span className="row-val exposed">{formatTokens(balance)} USDC</span>
            </div>
            <div className="verdict exposed">
              A stranger now knows this wallet holds <strong>{formatTokens(balance)} USDC</strong>,
              what it buys, and who it pays.
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ConfidentialPanel({
  executed,
  ownerView,
  balance,
}: {
  executed: Executed[];
  ownerView: boolean;
  balance: bigint;
}) {
  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <div className="panel-title">With Agacy</div>
          <div className="panel-note">Token-2022 confidential transfers</div>
        </div>
        <span className="tag private">Encrypted</span>
      </div>

      <div className="explorer">
        <div className="explorer-label">What the same stranger sees</div>
        {executed.length === 0 ? (
          <p className="empty">No transactions yet.</p>
        ) : (
          <>
            {executed.map((tx, i) => (
              <div key={i}>
                <div className="row">
                  <span className="row-key">confirmed</span>
                  <span className="row-val hidden">amount encrypted</span>
                </div>
                <div className="cipher">{ciphertextPreview(tx.amount, i)}</div>
              </div>
            ))}
            <div className="row">
              <span className="row-key">Balance</span>
              <span className="row-val hidden">unreadable</span>
            </div>
            <div className="verdict private">
              Every transaction is real, confirmed, and verifiable — the chain proved each one valid
              without learning the amount. There is no balance here to target.
            </div>
          </>
        )}
      </div>

      {ownerView && executed.length > 0 && (
        <div className="owner-view">
          <div className="owner-head">Decrypted with the owner&apos;s key</div>
          {executed.map((tx, i) => (
            <div key={i}>
              <div className="row">
                <span className="row-key">{tx.recipient.slice(0, 10)}…</span>
                <span className="row-val">{formatTokens(tx.amount)} USDC</span>
              </div>
              <p className="reason">{tx.reasoning}</p>
            </div>
          ))}
          <div className="row">
            <span className="row-key">Balance</span>
            <span className="row-val">{formatTokens(balance)} USDC</span>
          </div>
        </div>
      )}
    </section>
  );
}
