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
import type { ProvisionedPolicyDTO } from "../../server/dto/session.dto";
import {
  buildAttackSimulation,
  buildAuthorizedDemoHistory,
  ciphertextPreview,
  formatTokens,
  type AttackStepDTO,
} from "../../server/services/demo-scenario";
import { AgentSetup } from "../AgentSetup";
import { Dashboard } from "../Dashboard";
import { PURPOSE_PRESETS, toSpendPolicy } from "../../server/services/agent-setup";
import { provisionAgentPolicy } from "../../server/services/agent-provisioning";
import { fetchOnChainPolicyStatus } from "../../server/services/spend-policy";
import { createDevnetClient } from "../../server/data/solana-client";
import type { OnChainPolicyStatusDTO } from "../../server/dto/agent.dto";
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

const devnetClient = createDevnetClient();

/**
 * `/dashboard` is a real route rather than a `stage` value on `/` so that a
 * refresh reloads this route directly instead of resetting to the landing
 * page's initial state. Everything the owner has done here (draft, agent,
 * policy, run history) is mirrored into a session keyed to the connected
 * wallet address, so the refresh restores the screen, not just the wallet.
 */

const PERSONAL_TASKS: readonly AgentTask[] = [
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

/**
 * Same three-step shape as PERSONAL_TASKS, relabeled for a procurement
 * agent persona (docs/FEATURES.md item 8: presentation-layer only, no new
 * on-chain logic — the underlying Confidential Transfer / policy mechanism
 * is identical). Picked by `agent.purpose` in the run callback below.
 */
const PROCUREMENT_TASKS: readonly AgentTask[] = [
  {
    prompt: "Monthly hosting invoice from the infrastructure vendor came due.",
    amount: 4_200_000n,
    recipient: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK",
    recipientLabel: "Infrastructure vendor",
  },
  {
    prompt: "Raw materials supplier requested payment before the next shipment.",
    amount: 12_500_000n,
    recipient: "Cmp7yTn2WxLqE9vRb4sKfJ6hGpZa3MdUc8NrVwXt",
    recipientLabel: "Materials supplier",
  },
  {
    prompt: "Logistics partner invoice for last week's deliveries.",
    amount: 31_750_000n,
    recipient: "Dta9mKpR5nZwQ2eXcVb7yLsHfG4jTaU6dNrMwPkB",
    recipientLabel: "Logistics partner",
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
  const [provisionedPolicy, setProvisionedPolicy] = useState<ProvisionedPolicyDTO | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);
  const [onChainPolicy, setOnChainPolicy] = useState<OnChainPolicyStatusDTO | null>(null);
  const [onChainPolicyLoading, setOnChainPolicyLoading] = useState(false);

  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [executed, setExecuted] = useState<AgentExecutionDTO[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [ownerView, setOwnerView] = useState(false);
  const [showAttackSim, setShowAttackSim] = useState(false);
  const lastReasoning = useRef("");

  const reset = useCallback(() => {
    setSteps([]);
    setExecuted([]);
    setDone(false);
    setOwnerView(false);
    setShowAttackSim(false);
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
          setProvisionedPolicy(session.provisionedPolicy);
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
      provisionedPolicy,
    });
  }, [
    agent,
    dashboardSection,
    executed,
    hydrated,
    onboardingStep,
    ownerWallet,
    policy,
    provisionedPolicy,
    setupDraft,
  ]);

  // Once a policy account exists on devnet, the Policies view should show
  // what's actually written there rather than only the local draft — this is
  // the "reload from real data" half of provisioning, not just "create it."
  useEffect(() => {
    if (!provisionedPolicy) {
      setOnChainPolicy(null);
      return;
    }
    let active = true;
    setOnChainPolicyLoading(true);
    void fetchOnChainPolicyStatus(devnetClient, provisionedPolicy.policyAccount)
      .then((status) => {
        if (active) setOnChainPolicy(status);
      })
      .catch(() => {
        if (active) setOnChainPolicy(null);
      })
      .finally(() => {
        if (active) setOnChainPolicyLoading(false);
      });
    return () => {
      active = false;
    };
  }, [provisionedPolicy]);

  const disconnect = useCallback(async () => {
    if (!ownerWallet) return;
    try {
      await disconnectOwnerWallet(ownerWallet.provider);
    } finally {
      invalidateWallet();
    }
  }, [invalidateWallet, ownerWallet]);

  const createAgent = useCallback(
    async (draft: AgentDraftDTO) => {
      if (!ownerWallet) return;
      setProvisioning(true);
      setProvisioningError(null);
      try {
        const result = await provisionAgentPolicy({
          client: devnetClient,
          ownerWallet,
          draft,
        });
        setProvisionedPolicy(result);
        setAgent(draft);
        setPolicy(toSpendPolicy(draft));
        reset();
        setDashboardSection("run");
      } catch (error) {
        setProvisioningError(
          error instanceof Error
            ? error.message
            : "Could not create the policy account. Check your wallet and devnet SOL balance.",
        );
      } finally {
        setProvisioning(false);
      }
    },
    [ownerWallet, reset],
  );

  const run = useCallback(async () => {
    if (!policy) return;
    reset();
    setRunning(true);
    lastReasoning.current = "";

    await runAgent({
      tasks: agent?.purpose === "procurement" ? PROCUREMENT_TASKS : PERSONAL_TASKS,
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
  }, [agent, policy, reset]);

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
      onChainPolicy={onChainPolicy}
      onChainPolicyLoading={onChainPolicyLoading}
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
          onCreate={(draft) => void createAgent(draft)}
          provisioning={provisioning}
          provisioningError={provisioningError}
        />
      ) : dashboardSection === "run" && policy && agent ? (
        <div className="dashboard-run">
          <div className="dashboard-workspace-intro">
            <div>
              <h2>Watch {agent.name} work.</h2>
              <p>
                A scripted walkthrough of the decision flow, over a fixed set of vendors — so it
                runs the same way every time, with no API key and no funds at risk. The policy
                verdicts are the real engine, so the refusal below is a genuine evaluation rather
                than a staged one. Nothing here is broadcast to a cluster. The real agent — an
                actual model choosing its own tools, paying real devnet accounts — runs from the
                terminal, and its recorded output is on the proof page.
              </p>
            </div>
            <span className="hint">
              Max {formatTokens(policy.maxPerTransfer)} USDC per transfer
            </span>
          </div>

          {provisionedPolicy && (
            <p className="hint">
              Policy account created on devnet:{" "}
              <a
                href={`https://explorer.solana.com/address/${provisionedPolicy.policyAccount}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
              >
                {provisionedPolicy.policyAccount.slice(0, 8)}…
              </a>{" "}
              with these limits — that account is real, and you can open it. The walkthrough below
              does not sign against it: it uses a throwaway agent key, and keeping a real one is a
              key-custody decision this build deliberately leaves open. The enforcement path itself
              is built and verified on devnet — see the proof page.
            </p>
          )}

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
            <button onClick={() => setShowAttackSim(!showAttackSim)} disabled={executed.length === 0}>
              {showAttackSim ? "Hide attacker simulation" : "Simulate attacker"}
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

          {showAttackSim && (
            <AttackSimulationPanel
              steps={buildAttackSimulation(
                executed,
                balance,
                agent?.purpose === "procurement" ? "business" : "personal",
              )}
            />
          )}
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

function AttackSimulationPanel({ steps }: { steps: readonly AttackStepDTO[] }) {
  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <div className="panel-title">Simulated attacker</div>
          <div className="panel-note">Same scan, run against both wallets from the demo above</div>
        </div>
      </div>

      <div className="explorer">
        {steps.length === 0 ? (
          <p className="empty">Run the agent at least once first.</p>
        ) : (
          steps.map((step) => (
            <div key={step.id} className="row" style={{ alignItems: "flex-start" }}>
              <span className={`tag ${step.outcome === "revealed" ? "exposed" : "private"}`}>
                {step.target}
              </span>
              <span>
                <strong>{step.narrative}</strong>
                <br />
                <span className={step.outcome === "revealed" ? "row-val exposed" : "row-val hidden"}>
                  {step.detail}
                </span>
              </span>
            </div>
          ))
        )}
        {steps.length > 0 && (
          <div className="verdict private">
            Same attacker, same scan, same two transactions — one wallet gives up a target, the
            other gives up nothing.
          </div>
        )}
      </div>
    </section>
  );
}
