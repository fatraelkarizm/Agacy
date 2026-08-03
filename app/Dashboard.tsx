"use client";

import type { ReactNode } from "react";
import {
  ArrowSquareOut,
  Broadcast,
  Database,
  Eye,
  EyeSlash,
  FileText,
  Fingerprint,
  Gear,
  Key,
  ListBullets,
  LockKey,
  Plus,
  Question,
  Receipt,
  Robot,
  ShieldCheck,
  ShieldWarning,
  SignOut,
  SlidersHorizontal,
  SquaresFour,
  Users,
  Wallet,
} from "@phosphor-icons/react";
import type { AgentDraftDTO, OnChainPolicyStatusDTO, SpendPolicyDTO } from "../server/dto/agent.dto";
import type {
  AgentOperationalStatus,
  DashboardSection,
} from "../server/dto/dashboard.dto";
import type {
  AuthorizedTransactionDTO,
  PublicTransactionDTO,
} from "../server/dto/transaction.dto";
import type { WalletConnectionDTO } from "../server/dto/wallet.dto";
import { formatTokens } from "../server/services/demo-scenario";

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: SquaresFour },
  { id: "agents", label: "Agents", icon: Robot },
  { id: "transactions", label: "Transactions", icon: Receipt },
  { id: "policies", label: "Policies", icon: SlidersHorizontal },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "settings", label: "Settings", icon: Gear },
] as const;

const SECTION_TITLES: Record<DashboardSection, string> = {
  overview: "Agent Shell Overview",
  agents: "Autonomous Agents",
  transactions: "Transaction Registry",
  policies: "Spend Policies",
  security: "Privacy & Security",
  settings: "Owner Settings",
  onboarding: "Create private agent",
  run: "Agent execution",
};

interface DashboardProps {
  readonly section: DashboardSection;
  readonly ownerWallet: WalletConnectionDTO;
  readonly agent: AgentDraftDTO | null;
  readonly policy: SpendPolicyDTO | null;
  readonly onChainPolicy: OnChainPolicyStatusDTO | null;
  readonly onChainPolicyLoading: boolean;
  readonly publicTransactions: readonly PublicTransactionDTO[];
  readonly authorizedTransactions: readonly AuthorizedTransactionDTO[];
  readonly balance: bigint;
  readonly operationalStatus: AgentOperationalStatus;
  readonly currentTask: string;
  readonly ownerView: boolean;
  readonly onNavigate: (section: DashboardSection) => void;
  readonly onNewAgent: () => void;
  readonly onToggleOwnerView: () => void;
  readonly onDisconnect: () => void;
  readonly onProof: () => void;
  readonly onLanding: () => void;
  readonly children?: ReactNode;
}

export function Dashboard({
  section,
  ownerWallet,
  agent,
  policy,
  onChainPolicy,
  onChainPolicyLoading,
  publicTransactions,
  authorizedTransactions,
  balance,
  operationalStatus,
  currentTask,
  ownerView,
  onNavigate,
  onNewAgent,
  onToggleOwnerView,
  onDisconnect,
  onProof,
  onLanding,
  children,
}: DashboardProps) {
  const activeNav = section === "onboarding" || section === "run" ? "agents" : section;

  return (
    <div className="dashboard-app">
      <aside className="dashboard-sidebar">
        <button className="dashboard-brand" onClick={onLanding} aria-label="Return to Agacy landing">
          <span className="brand-mark" />
          <span>
            <strong>Agacy</strong>
            <small>Confidential agent shell</small>
          </span>
        </button>

        <nav className="dashboard-side-nav" aria-label="Owner dashboard">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={activeNav === id ? "active" : ""}
              onClick={() => onNavigate(id)}
            >
              <Icon aria-hidden="true" size={19} weight="duotone" />
              {label}
            </button>
          ))}
        </nav>

        <div className="dashboard-side-footer">
          <button className="primary dashboard-new-agent" onClick={onNewAgent}>
            <Plus aria-hidden="true" size={18} />
            New Agent
          </button>
          <a href="/docs">
            <FileText aria-hidden="true" size={18} weight="duotone" />
            Docs
          </a>
          <a href="/docs#boundaries">
            <Question aria-hidden="true" size={18} weight="duotone" />
            Support
          </a>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <h1>{SECTION_TITLES[section]}</h1>
          <div className="dashboard-session">
            <span className="dashboard-network">
              <span aria-hidden="true" />
              Solana devnet
            </span>
            <button onClick={() => onNavigate("settings")}>
              <Wallet aria-hidden="true" size={17} weight="duotone" />
              {shortAddress(ownerWallet.address)}
            </button>
          </div>
        </header>

        <main className="dashboard-content">
          {children ?? (
            <DashboardSectionContent
              section={section}
              ownerWallet={ownerWallet}
              agent={agent}
              policy={policy}
              onChainPolicy={onChainPolicy}
              onChainPolicyLoading={onChainPolicyLoading}
              publicTransactions={publicTransactions}
              authorizedTransactions={authorizedTransactions}
              balance={balance}
              operationalStatus={operationalStatus}
              currentTask={currentTask}
              ownerView={ownerView}
              onNavigate={onNavigate}
              onNewAgent={onNewAgent}
              onToggleOwnerView={onToggleOwnerView}
              onDisconnect={onDisconnect}
              onProof={onProof}
            />
          )}
        </main>
      </div>
    </div>
  );
}

type DashboardSectionContentProps = Omit<DashboardProps, "children" | "onLanding">;

function DashboardSectionContent(props: DashboardSectionContentProps) {
  switch (props.section) {
    case "overview":
      return <Overview {...props} />;
    case "agents":
      return (
        <AgentRegistry
          agent={props.agent}
          status={props.operationalStatus}
          currentTask={props.currentTask}
          onNewAgent={props.onNewAgent}
          onOpen={() => props.onNavigate("run")}
          expanded
        />
      );
    case "transactions":
      return (
        <TransactionWorkspace
          publicTransactions={props.publicTransactions}
          authorizedTransactions={props.authorizedTransactions}
          ownerView={props.ownerView}
          onToggleOwnerView={props.onToggleOwnerView}
        />
      );
    case "policies":
      return (
        <PolicyWorkspace
          policy={props.policy}
          onChainPolicy={props.onChainPolicy}
          onChainPolicyLoading={props.onChainPolicyLoading}
          onNewAgent={props.onNewAgent}
        />
      );
    case "security":
      return <SecurityWorkspace onProof={props.onProof} />;
    case "settings":
      return <SettingsWorkspace ownerWallet={props.ownerWallet} onDisconnect={props.onDisconnect} />;
    default:
      return null;
  }
}

function Overview({
  agent,
  policy,
  onChainPolicy,
  publicTransactions,
  balance,
  operationalStatus,
  currentTask,
  onNavigate,
  onNewAgent,
}: DashboardSectionContentProps) {
  return (
    <div className="dashboard-overview">
      <section className="dashboard-metrics" aria-label="Owner account overview">
        <MetricCard icon={Wallet} label="Managed balance" value={`${formatTokens(balance)} USDC`} note="Local demo state" />
        <MetricCard icon={LockKey} label="Privacy mode" value="Confidential" note="Amounts encrypted" accent />
        <MetricCard icon={Robot} label="Active agents" value={agent ? "01" : "00"} note={agent ? operationalStatus : "No agent yet"} />
        <MetricCard icon={Broadcast} label="Network" value="Solana devnet" note="Addresses remain public" />
      </section>

      <div className="dashboard-overview-grid">
        <AgentRegistry
          agent={agent}
          status={operationalStatus}
          currentTask={currentTask}
          onNewAgent={onNewAgent}
          onOpen={() => onNavigate("run")}
          onViewAll={() => onNavigate("agents")}
        />
        <PolicyShell
          policy={policy}
          onChainPolicy={onChainPolicy}
          onOpen={() => onNavigate("policies")}
        />
      </div>

      <PublicTransactionRegistry
        transactions={publicTransactions}
        onViewAll={() => onNavigate("transactions")}
      />
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  note,
  accent,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  note: string;
  accent?: boolean;
}) {
  return (
    <article className="dashboard-metric">
      <div className="dashboard-metric-head">
        <span>{label}</span>
        <Icon aria-hidden="true" size={20} weight="duotone" />
      </div>
      <strong className={accent ? "accent" : ""}>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function AgentRegistry({
  agent,
  status,
  currentTask,
  onNewAgent,
  onOpen,
  onViewAll,
  expanded,
}: {
  agent: AgentDraftDTO | null;
  status: AgentOperationalStatus;
  currentTask: string;
  onNewAgent: () => void;
  onOpen?: () => void;
  onViewAll?: () => void;
  expanded?: boolean;
}) {
  return (
    <section className={`dashboard-panel dashboard-agent-registry${expanded ? " expanded" : ""}`}>
      <PanelHeader icon={Robot} title="Autonomous Agents" action={onViewAll ? "View all" : undefined} onAction={onViewAll} />
      {agent ? (
        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead><tr><th>Agent identifier</th><th>Status</th><th>Current task</th><th>Encrypted balance</th></tr></thead>
            <tbody>
              <tr>
                <td>
                  <button className="dashboard-agent-link" onClick={onOpen}>{agent.name}</button>
                  <small>{humanize(agent.purpose)} shell</small>
                </td>
                <td><StatusBadge value={status} /></td>
                <td>{currentTask}</td>
                <td><span className="dashboard-hidden-value">••••••</span> <EyeSlash aria-hidden="true" size={16} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dashboard-empty-state">
          <Robot aria-hidden="true" size={34} weight="duotone" />
          <div><strong>No agent shell yet</strong><p>Create scoped authority before any autonomous payment can run.</p></div>
          <button className="primary" onClick={onNewAgent}>Create agent</button>
        </div>
      )}
    </section>
  );
}

function PolicyShell({
  policy,
  onChainPolicy,
  onOpen,
}: {
  policy: SpendPolicyDTO | null;
  onChainPolicy: OnChainPolicyStatusDTO | null;
  onOpen: () => void;
}) {
  // Three genuinely different states, kept distinct rather than collapsed into
  // a single "configured" badge: a local draft, a real account the program can
  // sign for, and an account the program actually holds. Only the last one
  // makes the limit unbypassable.
  const state = onChainPolicy?.custodiedTokenAccount
    ? "Custody held on-chain"
    : onChainPolicy
      ? "Provisioned — custody not handed over"
      : "Local draft only";

  return (
    <section className="dashboard-panel dashboard-policy-shell">
      <PanelHeader icon={ShieldCheck} title="Spend Policy Shell" />
      <div className="dashboard-policy-body">
        <p className="dashboard-label">Policy status</p>
        <strong>{policy ? "Demo policy" : "Not configured"}</strong>
        <span className="dashboard-policy-state">{state}</span>
        <div className="dashboard-policy-divider" />
        <p className="dashboard-label">Authority</p>
        <div className="dashboard-authority-row"><Key aria-hidden="true" size={18} weight="duotone" /><span>Owner controls limits</span></div>
        <div className="dashboard-authority-row"><ShieldWarning aria-hidden="true" size={18} weight="duotone" /><span>Agent cannot raise policy</span></div>
        <button onClick={onOpen}>Review policy</button>
      </div>
    </section>
  );
}

function PublicTransactionRegistry({
  transactions,
  onViewAll,
}: {
  transactions: readonly PublicTransactionDTO[];
  onViewAll?: () => void;
}) {
  return (
    <section className="dashboard-panel dashboard-transactions">
      <PanelHeader icon={ListBullets} title="Transaction Registry" action={onViewAll ? "View all" : undefined} onAction={onViewAll} />
      <p className="dashboard-source-note">Local demo trace</p>
      {transactions.length === 0 ? (
        <div className="dashboard-empty-state compact">
          <Receipt aria-hidden="true" size={29} weight="duotone" />
          <div><strong>No transaction history</strong><p>Run an agent to create a local confidential demo trace.</p></div>
        </div>
      ) : (
        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead><tr><th>Tx hash</th><th>Event type</th><th>Amount payload</th><th>Privacy mode</th><th>Status</th></tr></thead>
            <tbody>
              {transactions.map((transaction) => (
                <tr key={transaction.signature}>
                  <td><code>{shortSignature(transaction.signature)}</code></td>
                  <td>Transfer</td>
                  <td><span className="dashboard-hidden-value">•••••••••• USDC</span></td>
                  <td><span className="dashboard-private"><LockKey aria-hidden="true" size={15} /> Confidential</span></td>
                  <td>{humanize(transaction.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TransactionWorkspace({
  publicTransactions,
  authorizedTransactions,
  ownerView,
  onToggleOwnerView,
}: {
  publicTransactions: readonly PublicTransactionDTO[];
  authorizedTransactions: readonly AuthorizedTransactionDTO[];
  ownerView: boolean;
  onToggleOwnerView: () => void;
}) {
  return (
    <div className="dashboard-workspace">
      <div className="dashboard-workspace-intro">
        <div><h2>One history, two access boundaries.</h2><p>The public registry never receives decrypted amounts. Owner view uses a separate authorized DTO.</p></div>
        <button onClick={onToggleOwnerView} disabled={publicTransactions.length === 0}>
          {ownerView ? <EyeSlash aria-hidden="true" size={17} /> : <Eye aria-hidden="true" size={17} />}
          {ownerView ? "Hide owner view" : "Reveal owner view"}
        </button>
      </div>
      {ownerView ? (
        <AuthorizedTransactionRegistry transactions={authorizedTransactions} />
      ) : (
        <PublicTransactionRegistry transactions={publicTransactions} />
      )}
    </div>
  );
}

function AuthorizedTransactionRegistry({ transactions }: { transactions: readonly AuthorizedTransactionDTO[] }) {
  return (
    <section className="dashboard-panel dashboard-transactions">
      <PanelHeader icon={Eye} title="Authorized Transaction Registry" />
      <p className="dashboard-source-note">Owner-only local demo trace</p>
      {transactions.length === 0 ? (
        <div className="dashboard-empty-state compact"><Receipt aria-hidden="true" size={29} weight="duotone" /><div><strong>No owner history</strong><p>Complete an agent run first.</p></div></div>
      ) : (
        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead><tr><th>Tx hash</th><th>Amount</th><th>Counterparty</th><th>Resulting balance</th><th>Reason</th></tr></thead>
            <tbody>
              {transactions.map((transaction) => (
                <tr key={transaction.signature}>
                  <td><code>{shortSignature(transaction.signature)}</code></td>
                  <td className="dashboard-owner-value">{formatTokens(transaction.amount)} USDC</td>
                  <td><code>{shortAddress(transaction.counterparty)}</code></td>
                  <td>{formatTokens(transaction.resultingBalance)} USDC</td>
                  <td>{transaction.agentReasoning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PolicyWorkspace({
  policy,
  onChainPolicy,
  onChainPolicyLoading,
  onNewAgent,
}: {
  policy: SpendPolicyDTO | null;
  onChainPolicy: OnChainPolicyStatusDTO | null;
  onChainPolicyLoading: boolean;
  onNewAgent: () => void;
}) {
  return (
    <div className="dashboard-workspace">
      <div className="dashboard-workspace-intro">
        <div>
          <h2>Limits live outside the prompt.</h2>
          <p>Enforced by a program that signs for the account, not by the agent&apos;s good behaviour.</p>
        </div>
      </div>
      {policy ? (
        <section className="dashboard-policy-grid">
          <PolicyFact label="Per transfer" value={`${formatTokens(policy.maxPerTransfer)} USDC`} icon={Receipt} />
          <PolicyFact label="Per period" value={`${formatTokens(policy.maxPerPeriod)} USDC`} icon={Database} />
          <PolicyFact label="Recipients" value={policy.allowedRecipients.length ? String(policy.allowedRecipients.length) : "Any"} icon={Users} />
          <PolicyFact
            label="Chain status"
            value={onChainPolicyLoading ? "Checking devnet..." : onChainPolicy ? "Account provisioned" : "Not provisioned"}
            icon={onChainPolicy ? ShieldCheck : ShieldWarning}
          />
        </section>
      ) : (
        <div className="dashboard-empty-state standalone"><ShieldCheck aria-hidden="true" size={36} weight="duotone" /><div><strong>No spend policy configured</strong><p>Create an agent to define its spending boundary.</p></div><button className="primary" onClick={onNewAgent}>Create agent</button></div>
      )}

      {onChainPolicy && (
        <>
          <section className="dashboard-policy-grid">
            {/*
              Deliberately not falling back to the plaintext numbers when the
              limits are encrypted. The program refuses to enforce those fields
              in that state, so showing them would present a number that is not
              the policy — the exact confusion this feature exists to remove.
            */}
            <PolicyFact
              label="On-chain per transfer"
              value={onChainPolicy.limitsAreConfidential ? "Encrypted" : `${formatTokens(onChainPolicy.maxPerTransfer)} USDC`}
              icon={onChainPolicy.limitsAreConfidential ? LockKey : Receipt}
            />
            <PolicyFact
              label="On-chain per period"
              value={onChainPolicy.limitsAreConfidential ? "Encrypted" : `${formatTokens(onChainPolicy.maxPerPeriod)} USDC`}
              icon={onChainPolicy.limitsAreConfidential ? LockKey : Database}
            />
            <PolicyFact
              label="Spent this period"
              value={onChainPolicy.limitsAreConfidential ? "Encrypted" : `${formatTokens(onChainPolicy.spentInPeriod)} USDC`}
              icon={onChainPolicy.limitsAreConfidential ? LockKey : Receipt}
            />
            <PolicyFact label="Policy account" value={`${onChainPolicy.policyAccount.slice(0, 8)}…`} icon={Key} />
          </section>
          {onChainPolicy.limitsAreConfidential && <ConfidentialLimitNote />}
          <CustodyPanel custodiedTokenAccount={onChainPolicy.custodiedTokenAccount} />
        </>
      )}
    </div>
  );
}

function PolicyFact({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Receipt }) {
  return <article><Icon aria-hidden="true" size={23} weight="duotone" /><span>{label}</span><strong>{value}</strong></article>;
}

/**
 * Explains why the numbers above went blank, and — just as importantly — who
 * can still read them. "Encrypted" with no further detail invites the reader
 * to assume more privacy than is actually on offer.
 */
function ConfidentialLimitNote() {
  return (
    <section className="dashboard-panel">
      <PanelHeader icon={LockKey} title="Encrypted limits" />
      <div className="dashboard-policy-body">
        <p className="dashboard-label">Enforced without being read</p>
        <strong>Your budget is not a public number</strong>
        <div className="dashboard-policy-divider" />
        <div className="dashboard-authority-row">
          <Eye aria-hidden="true" size={18} weight="duotone" />
          <span>You and your agent hold the key</span>
        </div>
        <div className="dashboard-authority-row">
          <EyeSlash aria-hidden="true" size={18} weight="duotone" />
          <span>Anyone reading the chain sees ciphertext</span>
        </div>
      </div>
    </section>
  );
}

function CustodyPanel({ custodiedTokenAccount }: { custodiedTokenAccount: string | null }) {
  const held = custodiedTokenAccount !== null;
  return (
    <section className="dashboard-panel">
      <PanelHeader icon={held ? LockKey : Key} title="Token account custody" />
      <div className="dashboard-policy-body">
        <p className="dashboard-label">Who holds the account</p>
        <strong>{held ? "The policy program" : "You do"}</strong>
        <span className="dashboard-policy-state">
          {held ? `${custodiedTokenAccount.slice(0, 8)}…` : "Delegate mode"}
        </span>
        <div className="dashboard-policy-divider" />
        <div className="dashboard-authority-row">
          <ShieldCheck aria-hidden="true" size={18} weight="duotone" />
          <span>{held ? "Every payment passes the limit first" : "Limits stay advisory until you hand it over"}</span>
        </div>
        <div className="dashboard-authority-row">
          <ShieldWarning aria-hidden="true" size={18} weight="duotone" />
          <span>{held ? "You can take it back at any time" : "Handing it over makes the program the only way to move funds"}</span>
        </div>
      </div>
    </section>
  );
}

function SecurityWorkspace({ onProof }: { onProof: () => void }) {
  return (
    <div className="dashboard-workspace">
      <div className="dashboard-workspace-intro"><div><h2>Private amounts. Honest boundaries.</h2><p>Agacy separates what is verified today from the shielded architecture still being built.</p></div><button className="primary" onClick={onProof}><ArrowSquareOut aria-hidden="true" size={17} />View devnet proof</button></div>
      <section className="dashboard-security-grid">
        <article><LockKey aria-hidden="true" size={27} weight="duotone" /><strong>Amounts and balances</strong><p>Token-2022 confidential transfers encrypt value on Solana devnet.</p><StatusBadge value="verified" /></article>
        <article><SlidersHorizontal aria-hidden="true" size={27} weight="duotone" /><strong>Spend limits</strong><p>Stored as ciphertext and enforced by a program that never reads them. Your budget is not a public number.</p><StatusBadge value="verified" /></article>
        <article><Receipt aria-hidden="true" size={27} weight="duotone" /><strong>Transaction timing and count</strong><p>Every payment is still a visible on-chain event. How often an agent pays is observable, even though the sums are not.</p><StatusBadge value="public" /></article>
        <article><Fingerprint aria-hidden="true" size={27} weight="duotone" /><strong>Account addresses</strong><p>Sender and recipient addresses remain visible in the current implementation.</p><StatusBadge value="public" /></article>
        <article><Key aria-hidden="true" size={27} weight="duotone" /><strong>Authority split</strong><p>The owner wallet remains root authority. Agent spending permission is separate.</p><StatusBadge value="designed" /></article>
        <article><ShieldWarning aria-hidden="true" size={27} weight="duotone" /><strong>Shielded execution</strong><p>Address unlinkability and a private fee path are planned, not claimed as shipped.</p><StatusBadge value="planned" /></article>
      </section>
    </div>
  );
}

function SettingsWorkspace({ ownerWallet, onDisconnect }: { ownerWallet: WalletConnectionDTO; onDisconnect: () => void }) {
  return (
    <div className="dashboard-workspace settings-workspace">
      <div className="dashboard-workspace-intro"><div><h2>Owner connection.</h2><p>Agacy stores only the trusted provider session needed to restore this demo.</p></div></div>
      <dl className="dashboard-settings-list">
        <div><dt>Wallet address</dt><dd><code>{ownerWallet.address}</code></dd></div>
        <div><dt>Provider</dt><dd>{humanize(ownerWallet.provider)}</dd></div>
        <div><dt>Network</dt><dd>{humanize(ownerWallet.network)}</dd></div>
        <div><dt>Spending authority</dt><dd>Not granted by wallet connection</dd></div>
      </dl>
      <button className="dashboard-danger-button" onClick={onDisconnect}><SignOut aria-hidden="true" size={17} />Disconnect wallet</button>
    </div>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  action,
  onAction,
}: {
  icon: typeof Robot;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <header className="dashboard-panel-head">
      <h2><Icon aria-hidden="true" size={21} weight="duotone" />{title}</h2>
      {action && <button onClick={onAction}>{action}</button>}
    </header>
  );
}

function StatusBadge({ value }: { value: string }) {
  return <span className={`dashboard-status dashboard-status-${value}`}>{humanize(value)}</span>;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function shortSignature(signature: string): string {
  return `${signature.slice(0, 4)}...${signature.slice(-4)}`;
}

function humanize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ");
}
