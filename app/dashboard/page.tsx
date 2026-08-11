"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { address, type KeyPairSigner } from "@solana/kit";
import type { AgentTask } from "../../agent/loop";
import type {
  AgentDraftDTO,
  AgentExecutionDTO,
  AgentOnboardingStep,
  SpendPolicyDTO,
} from "../../server/dto/agent.dto";
import type { AgentRunGraphEventDTO } from "../../server/dto/agent-run.dto";
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
import { AgentExecutionGraph } from "../AgentExecutionGraph";
import { AgentGraphArena } from "../AgentGraphArena";
import { Dashboard } from "../Dashboard";
import { PURPOSE_PRESETS, toSpendPolicy } from "../../server/services/agent-setup";
import { provisionAgentPolicy } from "../../server/services/agent-provisioning";
import { createAgentRunGoalEvent, runAgentOnChain } from "../../server/services/agent-run";
import {
  ATTACKS,
  runAttack,
  type AttackDefinition,
  type AttackResult,
} from "../../server/services/agent-attacks";
import {
  createCustodyAccount,
  handOverCustody,
  readTokenAccountOwner,
  takeBackCustody,
  type CustodyAccountDTO,
} from "../../server/services/custody-demo";
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

const RUN_GOAL =
  "Process the queued operating payments. Check the on-chain policy before every payment and stop anything outside the owner's limits.";

const GOAL_GRAPH_EVENT = createAgentRunGoalEvent(RUN_GOAL);

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

  const [graphEvents, setGraphEvents] = useState<AgentRunGraphEventDTO[]>([GOAL_GRAPH_EVENT]);
  const [executed, setExecuted] = useState<AgentExecutionDTO[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [ownerView, setOwnerView] = useState(false);
  const [showAttackSim, setShowAttackSim] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /**
   * Memory only, deliberately. Persisting it would mean writing an agent's
   * signing key to browser storage, which is the decision PRODUCT_EXPERIENCE.md
   * leaves open — so a refresh loses the ability to run, and the UI says so
   * rather than silently falling back to a fake run.
   */
  const agentSignerRef = useRef<KeyPairSigner | null>(null);
  const [attackResults, setAttackResults] = useState<Record<string, AttackResult>>({});
  const [attackRunning, setAttackRunning] = useState<string | null>(null);
  const [custodyAccount, setCustodyAccount] = useState<CustodyAccountDTO | null>(null);
  const [custodyHolder, setCustodyHolder] = useState<string | null>(null);
  const [custodyBusy, setCustodyBusy] = useState(false);
  const [custodyError, setCustodyError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setRunError(null);
    setGraphEvents([GOAL_GRAPH_EVENT]);
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
        agentSignerRef.current = result.agentSigner;
        setProvisionedPolicy({
          policyAccount: result.policyAccount,
          agentAddress: result.agentAddress,
          signature: result.signature,
        });
        setAgent(draft);
        setPolicy(toSpendPolicy(draft));
        reset();
        setDashboardSection("graph");
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

  /**
   * Every verdict below comes from the deployed program, not from this file.
   * Each task sends a real `authorize` to devnet signed by the agent, so an
   * approval has a signature you can open and a refusal is the program's own
   * error. The previous version decided locally and then announced it had sent
   * something, which was not true.
   */
  const run = useCallback(async () => {
    const agentSigner = agentSignerRef.current;
    if (!policy || !provisionedPolicy || !agentSigner) return;

    reset();
    setRunning(true);
    setRunError(null);

    const tasks = (agent?.purpose === "procurement" ? PROCUREMENT_TASKS : PERSONAL_TASKS).map(
      (task) => ({
        label: task.recipientLabel,
        reasoning: task.prompt,
        amount: task.amount,
        recipient: task.recipient,
      }),
    );

    try {
      await runAgentOnChain({
        client: devnetClient,
        policyAccount: address(provisionedPolicy.policyAccount),
        agentSigner,
        goal: RUN_GOAL,
        tasks,
        onGraphEvent: (event) => {
          setGraphEvents((previous) => {
            const existing = previous.findIndex((item) => item.authorized.id === event.authorized.id);
            if (existing === -1) return [...previous, event];
            return previous.map((item, index) => (index === existing ? event : item));
          });
        },
        onStep: ({ task, outcome }) => {
          if (outcome.status === "authorized") {
            setExecuted((prev) => [
              ...prev,
              { amount: task.amount, recipient: task.recipient, reasoning: task.reasoning },
            ]);
          }
        },
      });
    } catch (error) {
      setRunError(
        error instanceof Error
          ? error.message
          : "The run could not reach devnet. Check the agent fee budget.",
      );
    }

    setRunning(false);
    setDone(true);
  }, [agent, policy, provisionedPolicy, reset]);

  /**
   * Runs one attack for real and stores whatever the chain said. Nothing here
   * decides the outcome — if an attack ever lands, it is reported as a breach.
   */
  const runOneAttack = useCallback(
    async (attack: AttackDefinition) => {
      const agentSigner = agentSignerRef.current;
      if (!ownerWallet || !provisionedPolicy || !agentSigner || !policy) return;

      setAttackRunning(attack.id);
      try {
        const result = await runAttack({
          client: devnetClient,
          ownerWallet,
          policyAccount: address(provisionedPolicy.policyAccount),
          agentSigner,
          maxPerTransfer: policy.maxPerTransfer,
          attack,
        });
        setAttackResults((prev) => ({ ...prev, [attack.id]: result }));
      } catch (error) {
        setAttackResults((prev) => ({
          ...prev,
          [attack.id]: {
            status: "inconclusive",
            detail: error instanceof Error ? error.message : "The attack could not be sent.",
          },
        }));
      } finally {
        setAttackRunning(null);
      }
    },
    [ownerWallet, policy, provisionedPolicy],
  );

  /**
   * Create, hand over, take back. Each step re-reads the token account's owner
   * from chain afterwards rather than assuming the transaction did what it was
   * meant to — the panel should show what is true, not what was requested.
   */
  const custodyAction = useCallback(
    async (action: "create" | "hand-over" | "take-back") => {
      if (!ownerWallet || !provisionedPolicy) return;
      setCustodyBusy(true);
      setCustodyError(null);
      try {
        let account = custodyAccount;
        if (action === "create") {
          account = await createCustodyAccount({ client: devnetClient, ownerWallet });
          setCustodyAccount(account);
        } else if (account) {
          const transition = action === "hand-over" ? handOverCustody : takeBackCustody;
          await transition({
            client: devnetClient,
            ownerWallet,
            policyAccount: address(provisionedPolicy.policyAccount),
            tokenAccount: address(account.tokenAccount),
          });
        }
        if (account) {
          setCustodyHolder(await readTokenAccountOwner(devnetClient, address(account.tokenAccount)));
        }
      } catch (error) {
        setCustodyError(
          error instanceof Error ? error.message : "The custody transaction did not go through.",
        );
      } finally {
        setCustodyBusy(false);
      }
    },
    [custodyAccount, ownerWallet, provisionedPolicy],
  );

  if (checkingSession || !ownerWallet) {
    return (
      <div className="wrap step-page">
        <p className="hint">Checking wallet session...</p>
      </div>
    );
  }

  if (dashboardSection === "graph") {
    return <AgentGraphArena onExit={() => setDashboardSection("overview")} />;
  }

  const spent = executed.reduce((sum, e) => sum + e.amount, 0n);
  const balance = INITIAL_BALANCE - spent;
  const authorizedTransactions = buildAuthorizedDemoHistory(executed, INITIAL_BALANCE);
  const publicTransactions = authorizedTransactions.map(toPublicView);
  const currentTask =
    graphEvents.length > 1
      ? graphEvents.at(-1)?.authorized.taskLabel ??
        graphEvents.at(-1)?.authorized.detail ??
        "Agent activity"
      : "Ready for a task";

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
        <div className="dashboard-run agent-graph-page">
          <div className="dashboard-workspace-intro">
            <div>
              <h2>{agent.name} mission control.</h2>
              <p>Watch one mandate fan out into policy-scoped actions across Solana devnet.</p>
            </div>
            <span className="hint">
              Max {formatTokens(policy.maxPerTransfer)} USDC per transfer
            </span>
          </div>

          {provisionedPolicy && (
            <p className="hint">
              Policy account:{" "}
              <a
                href={`https://explorer.solana.com/address/${provisionedPolicy.policyAccount}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
              >
                {provisionedPolicy.policyAccount.slice(0, 8)}…
              </a>
            </p>
          )}

          {!agentSignerRef.current && (
            <p className="hint">
              The session key expired on refresh. Create the agent again to restore autonomous signing.
            </p>
          )}

          {runError && <p className="hint">{runError}</p>}

          <section className="autonomy-strip" aria-label="Autonomy model">
            <div><small>Owner approval</small><strong>Once at setup</strong></div>
            <div><small>During a run</small><strong>Zero wallet prompts</strong></div>
            <div><small>Execution signer</small><strong>Session agent key</strong></div>
          </section>

          <div className="controls">
            <button className="primary" onClick={run} disabled={running || !agentSignerRef.current}>
              {running ? "Swarm running..." : done ? "Run unattended again" : "Start unattended run"}
            </button>
            <button onClick={reset} disabled={running || graphEvents.length <= 1}>
              Reset
            </button>
            <button onClick={() => setOwnerView(!ownerView)}>
              {ownerView ? "Hide owner view" : "View as owner"}
            </button>
            <button onClick={() => setShowAttackSim(!showAttackSim)}>
              {showAttackSim ? "Hide attacks" : "Attack this agent"}
            </button>
            {done && <button onClick={() => router.push("/proof")}>See on-chain proof</button>}
            <button onClick={() => setDashboardSection("overview")}>Back to overview</button>
            <span className="hint">
              {graphEvents.length <= 1
                ? "Idle."
                : `${executed.length} paid | ${formatTokens(balance)} USDC left`}
            </span>
          </div>

          <AgentExecutionGraph
            agentName={agent.name}
            agentAddress={provisionedPolicy?.agentAddress}
            publicEvents={graphEvents.map((event) => event.public)}
            authorizedEvents={graphEvents.map((event) => event.authorized)}
            ownerView={ownerView}
            running={running}
          />

          <div className="panels">
            <ExposedPanel executed={executed} balance={balance} />
            <ConfidentialPanel executed={executed} ownerView={ownerView} balance={balance} />
          </div>

          {showAttackSim && (
            <AttackConsole
              attacks={ATTACKS}
              results={attackResults}
              running={attackRunning}
              disabled={!agentSignerRef.current}
              onRun={(attack) => void runOneAttack(attack)}
            />
          )}

          <CustodyControls
            account={custodyAccount}
            holder={custodyHolder}
            policyAccount={provisionedPolicy?.policyAccount ?? null}
            busy={custodyBusy}
            error={custodyError}
            onAction={(action) => void custodyAction(action)}
          />

          {showAttackSim && executed.length > 0 && (
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

/**
 * Each row is a real transaction the owner can fire at their own agent.
 *
 * The verdict text comes from the chain, never from this component — a badge
 * that always says "blocked" would be decoration. A breach renders as a breach,
 * with the signature, because an attack demo that cannot fail proves nothing.
 */
/**
 * The custody transition, performed rather than described.
 *
 * `holder` is read back from the token account after every action, so what this
 * shows is the chain's answer to "who owns this", not a local guess about
 * whether the last transaction worked.
 */
function CustodyControls({
  account,
  holder,
  policyAccount,
  busy,
  error,
  onAction,
}: {
  account: CustodyAccountDTO | null;
  holder: string | null;
  policyAccount: string | null;
  busy: boolean;
  error: string | null;
  onAction: (action: "create" | "hand-over" | "take-back") => void;
}) {
  const heldByProgram = holder !== null && policyAccount !== null && holder === policyAccount;

  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <div className="panel-title">Token account custody</div>
          <div className="panel-note">
            {account
              ? heldByProgram
                ? "The program owns this account. Only it can move the funds."
                : "You own this account."
              : "Create an account to hand over."}
          </div>
        </div>
      </div>
      <div className="console-body">
        {account && (
          <div className="step step-observe">
            <span className="step-kind">account</span>
            <span className="step-text">
              <a
                href={`https://explorer.solana.com/address/${account.tokenAccount}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
              >
                {account.tokenAccount.slice(0, 24)}…
              </a>
              <br />
              <span style={{ opacity: 0.62 }}>owner: {holder ?? "checking…"}</span>
            </span>
          </div>
        )}
        {error && (
          <div className="step step-refused">
            <span className="step-kind">failed</span>
            <span className="step-text">{error}</span>
          </div>
        )}
        <div className="controls">
          {!account && (
            <button onClick={() => onAction("create")} disabled={busy || !policyAccount}>
              {busy ? "Sending…" : "Create token account"}
            </button>
          )}
          {account && !heldByProgram && (
            <button className="primary" onClick={() => onAction("hand-over")} disabled={busy}>
              {busy ? "Sending…" : "Hand over to the program"}
            </button>
          )}
          {account && heldByProgram && (
            <button onClick={() => onAction("take-back")} disabled={busy}>
              {busy ? "Sending…" : "Take it back"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function AttackConsole({
  attacks,
  results,
  running,
  disabled,
  onRun,
}: {
  attacks: readonly AttackDefinition[];
  results: Record<string, AttackResult>;
  running: string | null;
  disabled: boolean;
  onRun: (attack: AttackDefinition) => void;
}) {
  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <div className="panel-title">Attack this agent</div>
          <div className="panel-note">
            Real transactions, sent to devnet. Every verdict is the program&apos;s.
          </div>
        </div>
      </div>
      <div className="console-body">
        {attacks.map((attack) => {
          const result = results[attack.id];
          const busy = running === attack.id;
          return (
            <div className={`step step-${verdictClass(result)}`} key={attack.id}>
              <span className="step-kind">{verdictLabel(result, busy)}</span>
              <span className="step-text">
                <strong>{attack.goal}</strong>
                <br />
                {attack.method}
                {result && (
                  <>
                    <br />
                    <span style={{ opacity: 0.62 }}>
                      {result.status === "blocked"
                        ? `${result.detail} (error ${result.code})`
                        : result.status === "breached"
                          ? "This attack succeeded. The defence did not hold."
                          : result.detail}
                    </span>
                  </>
                )}
              </span>
              <button onClick={() => onRun(attack)} disabled={busy || disabled}>
                {busy ? "Sending…" : result ? "Run again" : "Run attack"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function verdictClass(result: AttackResult | undefined): string {
  if (!result) return "decide";
  if (result.status === "blocked") return "refused";
  if (result.status === "breached") return "execute";
  return "observe";
}

function verdictLabel(result: AttackResult | undefined, busy: boolean): string {
  if (busy) return "running";
  if (!result) return "ready";
  if (result.status === "blocked") return "blocked";
  if (result.status === "breached") return "BREACH";
  return "unclear";
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
            Same attacker, same scan, same two transactions. One wallet gives up a target, the
            other gives up nothing.
          </div>
        )}
      </div>
    </section>
  );
}
