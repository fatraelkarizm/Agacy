"use client";

import { useCallback, useRef, useState } from "react";
import { runAgent, type AgentStep, type AgentTask } from "../agent/loop";
import type { SpendPolicyDTO } from "../server/dto/agent.dto";
import { ciphertextPreview, formatTokens } from "../server/services/demo-scenario";
import devnetProof from "../server/data/devnet-proof.json";
import { AgentSetup } from "./AgentSetup";
import type { AgentDraftDTO } from "../server/services/agent-setup";

const DEFAULT_POLICY: SpendPolicyDTO = {
  maxPerTransfer: 20_000_000n,
  maxPerPeriod: 50_000_000n,
  allowedRecipients: [],
};

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
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [executed, setExecuted] = useState<Executed[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [ownerView, setOwnerView] = useState(false);
  const [policy, setPolicy] = useState<SpendPolicyDTO>(DEFAULT_POLICY);
  const [agent, setAgent] = useState<AgentDraftDTO | null>(null);
  const lastReasoning = useRef("");

  const run = useCallback(async () => {
    setSteps([]);
    setExecuted([]);
    setDone(false);
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
  }, [policy]);

  const reset = () => {
    setSteps([]);
    setExecuted([]);
    setDone(false);
    setOwnerView(false);
  };

  const spent = executed.reduce((sum, e) => sum + e.amount, 0n);
  const balance = INITIAL_BALANCE - spent;

  return (
    <>
      <header className="hero">
        <div className="wrap">
          <p className="eyebrow">Agacy — Agentic Privacy</p>
          <h1>
            Your AI agent spends on-chain.
            <br />
            Everyone can read <em>exactly</em> how much.
          </h1>
          <p className="lede">
            2.3 million AI agents already hold wallets and transact on their own. Every amount,
            balance, and counterparty is permanently public — and attackers now pick targets by
            reading balances. Agacy routes an agent&apos;s payments through Solana&apos;s
            confidential transfers: provably valid, unreadable amounts.
          </p>

          <div className="stats">
            <Stat value="2.3M" label="AI agents transacting on-chain today" />
            <Stat value="165M" label="agent payments processed via x402" />
            <Stat
              value="+207%"
              label="jump in phishing losses as attackers shifted to targeting visible balances"
            />
          </div>
        </div>
      </header>

      <main className="wrap sim">
        <AgentSetup
          onCreate={(draft, created) => {
            setAgent(draft);
            setPolicy(created);
            reset();
          }}
        />

        <div className="section-head">
          <h2>{agent ? `Watch ${agent.name} work.` : "Watch the agent work."}</h2>
          <p className="section-sub">
            A live agent loop with a 250 USDC budget, running under the limits set above:
            max {(Number(policy.maxPerTransfer) / 1e6).toLocaleString()} per transfer,{" "}
            {(Number(policy.maxPerPeriod) / 1e6).toLocaleString()} per period. It reasons about each
            task, proposes a payment, and the policy is checked <em>outside the model</em> before
            anything moves.
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
      </main>

      <section className="proof-band">
        <div className="wrap">
          <h2>Not a mockup — verified on devnet.</h2>
          <p className="section-sub">
            The flow above runs for real on Solana devnet. Below is an actual confidential transfer
            this codebase executed: the transaction is public and confirmed, and the transferred
            amount is provably absent from the recipient&apos;s account data.
          </p>

          <div className="proof-grid">
            <ProofItem label="Transfer transaction" value={devnetProof.transferSignature} link />
            <ProofItem label="Confidential mint" value={devnetProof.mint} link />
            <ProofItem label="Recipient account" value={devnetProof.recipientAccount} link />
            <ProofItem label="Policy program" value={devnetProof.policyProgramId} link />
            <div className="proof-item">
              <div className="proof-label">Amount readable on-chain</div>
              <div className="proof-verdict">
                {devnetProof.amountFoundInRecipientAccountData ? "yes" : "no — encrypted"}
              </div>
            </div>
          </div>
        </div>
      </section>

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

function ProofItem({ label, value, link }: { label: string; value: string; link?: boolean }) {
  const base = "https://explorer.solana.com";
  const href = base + "/address/" + value + "?cluster=devnet";
  const txHref = base + "/tx/" + value + "?cluster=devnet";
  return (
    <div className="proof-item">
      <div className="proof-label">{label}</div>
      {link ? (
        <a
          className="proof-value"
          href={label.includes("transaction") ? txHref : href}
          target="_blank"
          rel="noreferrer"
        >
          {value.slice(0, 22)}…
        </a>
      ) : (
        <div className="proof-value">{value}</div>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
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
    <section className="console">
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
    <section className="panel">
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
    <section className="panel">
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
