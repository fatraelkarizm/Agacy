"use client";

import Image from "next/image";
import {
  Brain,
  Buildings,
  CursorClick,
  Eye,
  EyeSlash,
  FileText,
  PaperPlaneTilt,
  Pulse,
  ShieldCheck,
  UserCircle,
  Wallet,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { runAgent, type AgentStep, type AgentTask } from "../agent/loop";
import type {
  AgentDraftDTO,
  AgentOnboardingStep,
  SpendPolicyDTO,
} from "../server/dto/agent.dto";
import type { WalletConnectionDTO } from "../server/dto/wallet.dto";
import { ciphertextPreview, formatTokens } from "../server/services/demo-scenario";
import devnetProof from "../server/data/devnet-proof.json";
import { AgentSetup } from "./AgentSetup";
import { WalletGate } from "./WalletGate";
import { PURPOSE_PRESETS, toSpendPolicy } from "../server/services/agent-setup";
import {
  disconnectOwnerWallet,
  restoreOwnerWallet,
  watchOwnerWalletSession,
} from "../server/services/wallet-connection";

/**
 * The demo is a guided walkthrough rather than one long page: you define an
 * agent, watch it run under those limits, then check the on-chain evidence.
 * Splitting it means each step can make one point properly instead of three
 * competing for the same screen.
 */

type Stage = "intro" | "connect" | "setup" | "run" | "proof";

const LANDING_LINKS = [
  { id: "product", label: "Product" },
  { id: "how-it-works", label: "How it works" },
  { id: "onboarding", label: "Onboarding" },
  { id: "privacy-stack", label: "Privacy stack" },
] as const;

const TASKS: readonly AgentTask[] = [
  {
    prompt: "Monthly API subscription came due, renewing at the usual rate.",
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
  const [ownerWallet, setOwnerWallet] = useState<WalletConnectionDTO | null>(null);
  const [restoringWallet, setRestoringWallet] = useState(true);
  const [setupDraft, setSetupDraft] = useState<AgentDraftDTO>({
    name: "Ops agent",
    purpose: "subscriptions",
    ...PURPOSE_PRESETS.subscriptions,
  });
  const [onboardingStep, setOnboardingStep] = useState<AgentOnboardingStep>("define");
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

  const invalidateWallet = useCallback(() => {
    setOwnerWallet(null);
    setAgent(null);
    setPolicy(null);
    reset();
    setStage("connect");
  }, [reset]);

  useEffect(() => {
    let active = true;
    void restoreOwnerWallet().then((wallet) => {
      if (active) setOwnerWallet(wallet);
    }).finally(() => {
      if (active) setRestoringWallet(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!ownerWallet) return;
    return watchOwnerWalletSession(ownerWallet.provider, invalidateWallet);
  }, [invalidateWallet, ownerWallet]);

  const disconnect = useCallback(async () => {
    if (!ownerWallet) return;
    try {
      await disconnectOwnerWallet(ownerWallet.provider);
    } finally {
      invalidateWallet();
    }
  }, [invalidateWallet, ownerWallet]);

  const showLandingSection = useCallback((sectionId: string) => {
    setStage("intro");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView());
    });
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
          <button className="brand" onClick={() => showLandingSection("product")} aria-label="Agacy home">
            <span className="brand-mark" />
            Agacy
          </button>
          <div className="nav-links" aria-label="Landing page sections">
            {LANDING_LINKS.map((link) => (
              <button key={link.id} onClick={() => showLandingSection(link.id)}>
                {link.label}
              </button>
            ))}
            <a href="/docs">
              <FileText aria-hidden="true" size={14} weight="duotone" />
              Docs
            </a>
          </div>
          <div className="nav-actions">
            {ownerWallet && (
              <button className="nav-disconnect" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
            <button
              className="primary nav-launch"
              onClick={() => setStage(ownerWallet ? "setup" : "connect")}
              disabled={restoringWallet}
            >
              {!restoringWallet && !ownerWallet && (
                <Wallet aria-hidden="true" size={17} weight="duotone" />
              )}
              {restoringWallet
                ? "Checking wallet..."
                : ownerWallet
                  ? shortAddress(ownerWallet.address)
                  : "Connect wallet"}
            </button>
          </div>
        </div>
      </nav>

      {stage === "intro" && (
        <Intro
          onStart={() => setStage(ownerWallet ? "setup" : "connect")}
          onProof={() => setStage("proof")}
        />
      )}

      {stage === "connect" && (
        <div className="wrap step-page wallet-page">
          <div className="step-head">
            <div className="step-index">Owner wallet</div>
            <h2>Connect before creating an agent.</h2>
            <p className="section-sub">
              Your wallet remains the root authority for policy, recovery, and revocation. The
              agent receives separate scoped permission later.
            </p>
          </div>
          <WalletGate
            onConnected={(wallet) => {
              setOwnerWallet(wallet);
              setStage("setup");
            }}
          />
        </div>
      )}

      {stage === "setup" && ownerWallet && (
        <div className="wrap step-page">
          <div className="step-head">
            <div className="step-index">Policy setup</div>
            <h2>Create your agent.</h2>
            <p className="section-sub">
              You define what it may do once. The limits then live in an account on-chain, not in a
              prompt the agent could be talked out of.
            </p>
            {ownerWallet && (
              <p className="connected-owner">
                <span aria-hidden="true" /> {shortAddress(ownerWallet.address)} connected via{" "}
                {ownerWallet.provider} on {ownerWallet.network}
              </p>
            )}
          </div>
          <AgentSetup
            draft={setupDraft}
            ownerWallet={ownerWallet}
            step={onboardingStep}
            onDraftChange={setSetupDraft}
            onStepChange={setOnboardingStep}
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
            <div className="step-index">Agent run</div>
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
              {running ? "Agent running..." : done ? "Run again" : "Start agent"}
            </button>
            <button onClick={reset} disabled={running || steps.length === 0}>
              Reset
            </button>
            <button onClick={() => setOwnerView(!ownerView)} disabled={executed.length === 0}>
              {ownerView ? "Hide owner view" : "View as owner"}
            </button>
            {done && (
              <button className="primary" onClick={() => setStage("proof")}>
                See on-chain proof
              </button>
            )}
            <span className="hint">
              {steps.length === 0
                ? "Idle."
                : `${executed.length} paid | ${formatTokens(balance)} USDC left`}
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
          The blocked payment is not the model changing its mind. The agent still proposes it. The
          spend policy is enforced outside the model, so a prompt-injected or malfunctioning agent
          cannot talk its way past it. Amounts are hidden by Solana&apos;s native Token-2022
          confidential transfers.
        </div>
      </footer>
    </>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function Intro({ onStart, onProof }: { onStart: () => void; onProof: () => void }) {
  return (
    <main className="landing">
      <section className="hero" id="product">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="hero-eyebrow">Confidential agent wallet on Solana</p>
            <h1>
              <span className="hero-line">Autonomous money.</span>
              <span className="accent hero-line">Private by default.</span>
            </h1>
            <p className="lede">
              Agacy lets AI agents transact on Solana while balances, amounts, and policies stay
              encrypted on-chain.
            </p>
            <div className="hero-cta">
              <button className="primary" onClick={onStart}>
                Launch demo
              </button>
              <button className="text-button" onClick={onProof}>
                View proof <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>

          <HeroVideo />

          <section className="hero-proof" aria-label="Agacy privacy proof">
            <div className="proof-public">
              <p className="proof-kicker">Public view</p>
              <h2>Confirmed, not exposed.</h2>
              <p>Anyone can verify the transaction. The amount and resulting balance stay hidden.</p>
              <code>amount: ••••••</code>
            </div>

            <div className="proof-authorized">
              <p className="proof-kicker">Authorized view</p>
              <p className="owner-amount">12.5 USDC</p>
              <p>Owner-only detail and agent reasoning.</p>
            </div>

            <div className="proof-rail" aria-label="Verified technology">
              <div>
                <strong>Token-2022</strong>
                <span>Confidential transfers</span>
              </div>
              <div>
                <strong>ZK proofs</strong>
                <span>Protocol validation</span>
              </div>
              <div>
                <strong>Devnet verified</strong>
                <span>Real transaction</span>
              </div>
            </div>
          </section>
        </div>
      </section>

      <section className="landing-section exposure-section">
        <div className="wrap exposure-bento">
          <div className="section-copy exposure-intro">
            <EyeSlash className="bento-ghost-icon" aria-hidden="true" weight="duotone" />
            <h2>A public ledger becomes an intelligence feed.</h2>
            <p>
              Continuous agent activity exposes balances, spending patterns, and business
              relationships to anyone watching the chain.
            </p>
          </div>
          <article className="exposure-cell exposure-personal">
            <UserCircle aria-hidden="true" size={31} weight="duotone" />
            <div>
              <h3>Personal wallets</h3>
              <p>Visible balances make owners easier to profile and target.</p>
            </div>
          </article>
          <article className="exposure-cell exposure-business">
            <Buildings aria-hidden="true" size={29} weight="duotone" />
            <div>
              <h3>Business agents</h3>
              <p>History can reveal suppliers, revenue signals, and strategy.</p>
            </div>
          </article>
          <article className="exposure-cell exposure-always-on">
            <Pulse aria-hidden="true" size={29} weight="duotone" />
            <div>
              <h3>Always-on activity</h3>
              <p>Every autonomous action adds searchable financial data.</p>
            </div>
          </article>
        </div>
      </section>

      <section className="landing-section boundary-section" id="how-it-works">
        <div className="wrap boundary-bento">
          <div className="section-copy boundary-intro">
            <ShieldCheck className="bento-ghost-icon" aria-hidden="true" weight="duotone" />
            <h2>Autonomy needs a boundary outside the model.</h2>
            <p>
              The agent may propose a payment. Agacy checks policy before funds move, so a prompt
              cannot negotiate past the account limits.
            </p>
          </div>
          <article className="sequence-cell sequence-observe">
            <Eye aria-hidden="true" size={27} weight="duotone" />
            <strong>Observe</strong>
            <span>Read the task</span>
          </article>
          <article className="sequence-cell sequence-reason">
            <Brain aria-hidden="true" size={27} weight="duotone" />
            <strong>Reason</strong>
            <span>Choose an action</span>
          </article>
          <article className="sequence-cell sequence-decide">
            <CursorClick aria-hidden="true" size={27} weight="duotone" />
            <strong>Decide</strong>
            <span>Propose payment</span>
          </article>
          <article className="sequence-cell sequence-policy">
            <ShieldCheck aria-hidden="true" size={27} weight="duotone" />
            <strong>Policy check</strong>
            <span>Enforce owner limits</span>
          </article>
          <article className="sequence-cell sequence-execute">
            <PaperPlaneTilt aria-hidden="true" size={29} weight="duotone" />
            <div>
              <strong>Execute</strong>
              <span>Transfer privately only after policy approval.</span>
            </div>
          </article>
        </div>
      </section>

      <section className="landing-section onboarding-section" id="onboarding">
        <div className="wrap onboarding-overview">
          <div className="section-copy">
            <h2>From wallet connection to bounded autonomy.</h2>
            <p>
              The owner establishes control first. Agent authority is introduced gradually and
              reviewed before anything can execute.
            </p>
          </div>
          <ol className="onboarding-journey">
            <li>
              <span>01</span>
              <div>
                <strong>Connect owner wallet</strong>
                <p>Phantom or Solflare becomes the root authority.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Define the agent</strong>
                <p>Name its job and choose the operating purpose.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Set spending policy</strong>
                <p>Cap each transfer and the total period budget.</p>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>Choose privacy access</strong>
                <p>Keep owner detail separate from public metadata.</p>
              </div>
            </li>
            <li>
              <span>05</span>
              <div>
                <strong>Review and authorize</strong>
                <p>The owner approves scoped authority before the run.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section className="landing-section stack-section" id="privacy-stack">
        <div className="wrap privacy-bento">
          <div className="bento-visual">
            <Image
              src="/agacy-privacy-primitives-3d.png"
              alt="Three-dimensional encrypted vault, zero-knowledge prism, and policy gate"
              fill
              sizes="(max-width: 760px) 100vw, 58vw"
            />
          </div>
          <div className="bento-intro">
            <p className="proof-kicker">Solana-native privacy</p>
            <h2>Privacy where value moves.</h2>
            <p>
              Agacy uses protocol-level primitives instead of routing agents through a separate
              privacy network.
            </p>
          </div>
          <article className="bento-detail bento-token">
            <strong>Token-2022</strong>
            <span>Encrypted balances and transfer amounts stay native to Solana.</span>
          </article>
          <article className="bento-detail bento-zk">
            <strong>ZK proofs</strong>
            <span>Transfers prove validity without exposing their size.</span>
          </article>
          <article className="bento-detail bento-policy">
            <strong>Policy gate</strong>
            <span>Spend limits live outside the agent prompt.</span>
          </article>
        </div>
      </section>

      <section className="landing-cta">
        <div className="wrap landing-cta-inner">
          <h2>Let the agent act.<br />Keep the ledger quiet.</h2>
          <button className="primary" onClick={onStart}>Launch demo</button>
        </div>
      </section>
    </main>
  );
}

function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPlayback = () => {
      if (motionPreference.matches) videoRef.current?.pause();
      else void videoRef.current?.play().catch(() => undefined);
    };

    syncPlayback();
    motionPreference.addEventListener("change", syncPlayback);
    return () => motionPreference.removeEventListener("change", syncPlayback);
  }, []);

  return (
    <div className="hero-media">
      <video
        ref={videoRef}
        muted
        loop
        playsInline
        preload="metadata"
        poster="/agacy-encrypted-core.png"
        aria-label="Encrypted transaction paths moving through a protected vault core"
      >
        <source src="/agacy-private-core.mp4" type="video/mp4" />
      </video>
    </div>
  );
}

function Proof() {
  return (
    <div className="wrap step-page">
      <div className="step-head">
        <div className="step-index">On-chain evidence</div>
        <h2>Not a mockup. Verified on devnet.</h2>
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
            {devnetProof.amountFoundInRecipientAccountData ? "yes" : "no, encrypted"}
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
              Every transaction is real, confirmed, and verifiable. The chain proved each one valid
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
