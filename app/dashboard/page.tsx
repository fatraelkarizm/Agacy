"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { runAgent, type AgentStep, type AgentTask } from "../../agent/loop";
import type {
  AgentDraftDTO,
  AgentExecutionDTO,
  AgentOnboardingStep,
  SpendPolicyDTO,
} from "../../server/dto/agent.dto";
import type { DashboardSection } from "../../server/dto/dashboard.dto";
import { toPublicView } from "../../server/dto/transaction.dto";
import type { WalletConnectionDTO } from "../../server/dto/wallet.dto";
import {
  buildAuthorizedDemoHistory,
  ciphertextPreview,
  formatTokens,
} from "../../server/services/demo-scenario";
import { AgentSetup } from "../AgentSetup";
import { Dashboard } from "../Dashboard";
import { PURPOSE_PRESETS, toSpendPolicy } from "../../server/services/agent-setup";
import {
  disconnectOwnerWallet,
  restoreOwnerWallet,
  watchOwnerWalletSession,
} from "../../server/services/wallet-connection";
import {
  clearDashboardSessionFor,
  loadDashboardSession,
  saveDashboardSession,
} from "../../server/services/session-state";

/**
 * `/dashboard` is a real route rather than a `stage` value on `/` so that a
 * refresh reloads this route directly instead of resetting to the landing
 * page's initial state. Everything the owner has done here (draft, agent,
 * policy, run history) is mirrored into a session keyed to the connected
 * wallet address, so the refresh restores the screen, not just the wallet.
 */

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

const DEFAULT_DRAFT: AgentDraftDTO = {
  name: "Ops agent",
  purpose: "subscriptions",
  ...PURPOSE_PRESETS.subscriptions,
};

export default function DashboardPage() {
  const router = useRouter();

  const [ownerWallet, setOwnerWallet] = useState<WalletConnectionDTO | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  const [dashboardSection, setDashboardSection] = useState<DashboardSection>("overview");
  const [setupDraft, setSetupDraft] = useState<AgentDraftDTO>(DEFAULT_DRAFT);
  const [onboardingStep, setOnboardingStep] = useState<AgentOnboardingStep>("define");
  const [agent, setAgent] = useState<AgentDraftDTO | null>(null);
  const [policy, setPolicy] = useState<SpendPolicyDTO | null>(null);

  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [executed, setExecuted] = useState<AgentExecutionDTO[]>([]);
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

  // Wallet session guard: this route requires a restorable wallet. No wallet,
  // no dashboard — send the visitor back to connect, per PRODUCT_EXPERIENCE.md
  // section 4 (wallet connection is the root authority gate).
  useEffect(() => {
    let active = true;
    void restoreOwnerWallet()
      .then((wallet) => {
        if (!active) return;
        if (!wallet) {
          router.replace("/");
          return;
        }
        setOwnerWallet(wallet);

        const session = loadDashboardSession(wallet.address);
        if (session) {
          setDashboardSection(session.dashboardSection);
          setOnboardingStep(session.onboardingStep);
          setSetupDraft(session.setupDraft);
          setAgent(session.agent);
          setPolicy(session.policy);
          setExecuted([...session.executed]);
        }
        setHydrated(true);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  const invalidateWallet = useCallback(() => {
    if (ownerWallet) clearDashboardSessionFor(ownerWallet.address);
    router.replace("/");
  }, [ownerWallet, router]);

  useEffect(() => {
    if (!ownerWallet) return;
    return watchOwnerWalletSession(ownerWallet.provider, invalidateWallet);
  }, [invalidateWallet, ownerWallet]);

  // Persist everything the owner can lose on refresh. Guarded by `hydrated` so
  // the initial render (before a saved session is loaded) cannot immediately
  // overwrite it with the pre-hydration defaults.
  useEffect(() => {
    if (!ownerWallet || !hydrated) return;
    saveDashboardSession({
      ownerAddress: ownerWallet.address,
      dashboardSection,
      onboardingStep,
      setupDraft,
      agent,
      policy,
      executed,
    });
  }, [agent, dashboardSection, executed, hydrated, onboardingStep, ownerWallet, policy, setupDraft]);

  const disconnect = useCallback(async () => {
    if (!ownerWallet) return;
    try {
      await disconnectOwnerWallet(ownerWallet.provider);
    } finally {
      invalidateWallet();
    }
  }, [invalidateWallet, ownerWallet]);

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

  if (checkingSession || !ownerWallet) {
    return (
      <div className="wrap step-page">
        <p className="hint">Checking wallet session...</p>
      </div>
    );
  }

  const spent = executed.reduce((sum, e) => sum + e.amount, 0n);
  const balance = INITIAL_BALANCE - spent;
  const authorizedTransactions = buildAuthorizedDemoHistory(executed, INITIAL_BALANCE);
  const publicTransactions = authorizedTransactions.map(toPublicView);
  const currentTask = steps.at(-1)?.text ?? "Ready for a task";

  return (
    <Dashboard
      section={dashboardSection}
      ownerWallet={ownerWallet}
      agent={agent}
      policy={policy}
      publicTransactions={publicTransactions}
      authorizedTransactions={authorizedTransactions}
      balance={balance}
      operationalStatus={running ? "active" : "idle"}
      currentTask={currentTask}
      ownerView={ownerView}
      onNavigate={setDashboardSection}
      onNewAgent={() => setDashboardSection("onboarding")}
      onToggleOwnerView={() => setOwnerView((visible) => !visible)}
      onDisconnect={() => void disconnect()}
      onProof={() => router.push("/proof")}
      onLanding={() => router.push("/")}
    >
      {dashboardSection === "onboarding" ? (
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
            setDashboardSection("run");
          }}
        />
      ) : dashboardSection === "run" && policy && agent ? (
        <div className="dashboard-run">
          <div className="dashboard-workspace-intro">
            <div>
              <h2>Watch {agent.name} work.</h2>
              <p>
                The agent proposes each payment. The policy check runs outside the model before
                value moves.
              </p>
            </div>
            <span className="hint">
              Max {formatTokens(policy.maxPerTransfer)} USDC per transfer
            </span>
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
            {done && <button onClick={() => router.push("/proof")}>See on-chain proof</button>}
            <button onClick={() => setDashboardSection("overview")}>Back to overview</button>
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
      ) : undefined}
    </Dashboard>
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

function ExposedPanel({ executed, balance }: { executed: AgentExecutionDTO[]; balance: bigint }) {
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
  executed: AgentExecutionDTO[];
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
