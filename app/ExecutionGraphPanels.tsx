"use client";

import { useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  Circle,
  Eye,
  EyeSlash,
  LockKey,
  Prohibit,
  Spinner,
  X,
} from "@phosphor-icons/react";
import {
  NODE_KIND_META,
  REDACTED_DETAIL,
  authorizedSpendTokens,
  formatClock,
  formatDuration,
  isAisaPowered,
  toolProvider,
  toPublicGraphNode,
  type ExecutionNode,
  type ExecutionNodeStatus,
  type PublicExecutionNode,
} from "./execution-graph-model";

/* ---------------------------------- stats --------------------------------- */

interface GraphStatsProps {
  readonly nodes: readonly ExecutionNode[];
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly elapsedLabel: string;
  readonly ownerView: boolean;
}

export function GraphStats({
  nodes,
  running,
  startedAt,
  elapsedLabel,
  ownerView,
}: GraphStatsProps) {
  const [revealed, setRevealed] = useState(false);

  const done = nodes.filter((node) => node.status === "done").length;
  const blocked = nodes.filter((node) => node.status === "blocked").length;
  // Counted on the tool node, not the result node. Both carry `toolResult`, so
  // counting either one alone is what keeps a single call from reading as two.
  const executedTools = nodes.filter(
    (node) => node.toolCall !== undefined && node.toolResult !== undefined,
  );
  const succeededTools = executedTools.filter((node) => node.toolResult?.status === "succeeded");
  const completion = nodes.length > 0 ? Math.round((done / nodes.length) * 100) : 0;
  const spend = authorizedSpendTokens(nodes);
  // Counted on the tool node only, for the same reason as `executedTools`:
  // the result node carries the same tool name and would double every call.
  const aisaCalls = executedTools.filter(isAisaPowered).length;

  return (
    <section className="xstats" aria-label="Run summary">
      <article className="xstat">
        <span className="xstat-label">Status</span>
        <strong className={running ? "xstat-live" : ""}>
          {running ? "Running" : startedAt === null ? "Idle" : "Complete"}
        </strong>
        <small>{startedAt === null ? "No goal sent yet" : elapsedLabel}</small>
      </article>

      <article className="xstat">
        <span className="xstat-label">Nodes</span>
        <strong>{nodes.length}</strong>
        <small>{blocked > 0 ? `${blocked} refused` : "Total in graph"}</small>
      </article>

      <article className="xstat">
        <span className="xstat-label">Completed</span>
        <strong className="xstat-good">{done}</strong>
        <small>{nodes.length > 0 ? `${completion}% of graph` : "Nothing yet"}</small>
      </article>

      <article className="xstat">
        <span className="xstat-label">Tool calls</span>
        <strong>{executedTools.length}</strong>
        <small>
          {executedTools.length === 0
            ? "None executed"
            : `${succeededTools.length} succeeded`}
        </small>
      </article>

      <article className="xstat">
        <span className="xstat-label">Via AIsa</span>
        <strong className={aisaCalls > 0 ? "xstat-aisa" : ""}>{aisaCalls}</strong>
        <small>{aisaCalls === 0 ? "No sponsor calls yet" : "Independent data source"}</small>
      </article>

      <article className="xstat">
        <span className="xstat-label">Authorized</span>
        <strong className="xstat-confidential">
          {/*
            The reveal button only exists in owner view. In public view there is
            no affordance to unmask at all, because an affordance a viewer
            cannot use still implies the value is sitting there waiting.
          */}
          {spend === 0
            ? "—"
            : ownerView && revealed
              ? `${spend.toLocaleString()} USDC`
              : "•••••••••• USDC"}
          {spend > 0 && ownerView && (
            <button
              className="xstat-reveal"
              onClick={() => setRevealed((visible) => !visible)}
              aria-label={revealed ? "Hide authorized amount" : "Reveal authorized amount"}
            >
              {revealed ? <EyeSlash aria-hidden="true" size={13} /> : <Eye aria-hidden="true" size={13} />}
            </button>
          )}
        </strong>
        {/*
          Deliberately not called "spent". `authorize_policy_spend` proves the
          program accepted the amount against the policy; it does not move
          tokens. Labelling it as a transfer would overstate what ran.
        */}
        <small>{spend === 0 ? "No spend authorized" : "Policy-approved, not transferred"}</small>
      </article>
    </section>
  );
}

/* --------------------------- model-provider boundary ------------------------ */

/**
 * The honest answer to "prove nothing leaks".
 *
 * Something does leave this machine: the graph calls an OpenAI-compatible
 * endpoint to expand each node. Tool results are redacted into `modelSummary`
 * before they go (agent/graph-actions.ts), but the owner's own goal text is
 * posted verbatim — and agent/graph-actions.ts:302 (`mentionsAmount`) actually
 * *requires* the amount to appear in the goal before `authorize_policy_spend`
 * will run. A demo that quietly skipped the one place data crosses the network
 * would not survive the first question about it.
 *
 * Wording stays inside the claim gates in docs/PRIVACY_ARCHITECTURE.md §10.
 */
export function ModelBoundaryPanel() {
  return (
    // Collapsed by default. It is reference material, not live run data, and at
    // full height it squeezed the canvas and pushed the page into a scroll.
    // Still one click away rather than buried in the docs.
    <details className="xboundary">
      <summary>
        <LockKey aria-hidden="true" size={15} weight="duotone" />
        What leaves this machine
      </summary>
      <div className="xboundary-grid">
        <div>
          <p className="xboundary-label">Sent to the model provider</p>
          <ul>
            <li>Your goal text, verbatim — including any amount or recipient you typed</li>
            <li>Node labels, such as &ldquo;Get SOL price&rdquo;</li>
            <li>Redacted tool observations</li>
          </ul>
        </div>
        <div>
          <p className="xboundary-label">Never sent</p>
          <ul>
            <li>Owner-only step detail</li>
            <li>Decrypted amounts and policy limits</li>
            <li>Wallet and recipient addresses read by tools</li>
          </ul>
        </div>
      </div>
      <p className="xboundary-note">
        Graph nodes are local to this browser. They are not written on-chain and are not
        persisted between sessions.
      </p>
    </details>
  );
}

/* ------------------------------- detail panel ------------------------------ */

interface NodeDetailPanelProps {
  readonly node: ExecutionNode;
  readonly ownerView: boolean;
  readonly onClose: () => void;
}

/**
 * The split is structural, not a set of conditionals inside one component.
 * `PublicNodeDetail` is typed to `PublicExecutionNode`, so it has no `detail`,
 * no `toolCall.input` and no `toolResult` to render even by mistake — the same
 * reasoning as the closed `PublicTransactionDTO` in server/dto/transaction.dto.ts.
 */
export function NodeDetailPanel({ node, ownerView, onClose }: NodeDetailPanelProps) {
  return ownerView
    ? <OwnerNodeDetail node={node} onClose={onClose} />
    : <PublicNodeDetail node={toPublicGraphNode(node)} onClose={onClose} />;
}

function PublicNodeDetail({
  node,
  onClose,
}: {
  node: PublicExecutionNode;
  onClose: () => void;
}) {
  const meta = NODE_KIND_META[node.kind];
  const duration = formatDuration(node);

  return (
    <aside className="xdetail" aria-label={`Public details for ${node.label}`}>
      <header className="xdetail-head">
        <div>
          <span className={`xdetail-kind xdetail-kind-${meta.tone}`}>{meta.label}</span>
          <h3>{node.label}</h3>
        </div>
        <button onClick={onClose} aria-label="Close node details">
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      <dl className="xdetail-facts">
        <div>
          <dt>Status</dt>
          <dd><StatusPill status={node.status} /></dd>
        </div>
        <div>
          <dt>Depth</dt>
          <dd>{node.depth}</dd>
        </div>
        {node.startedAt !== undefined && (
          <div>
            <dt>Started</dt>
            <dd>{formatClock(node.startedAt)}</dd>
          </div>
        )}
        {duration && (
          <div>
            <dt>Duration</dt>
            <dd>{duration}</dd>
          </div>
        )}
      </dl>

      {node.toolName && (
        <section className="xdetail-section">
          <h4>Tool call</h4>
          <p className="xdetail-tool">
            {node.toolName}
            {node.toolName && <ProviderChip node={{ toolResult: { tool: node.toolName } as never }} />}
          </p>
          <p className="xdetail-withheld">
            <LockKey aria-hidden="true" size={13} />
            Arguments withheld
          </p>
        </section>
      )}

      <section className="xdetail-section">
        <h4>Detail</h4>
        <p className="xdetail-withheld">
          <LockKey aria-hidden="true" size={13} />
          {REDACTED_DETAIL}
        </p>
      </section>
    </aside>
  );
}

function OwnerNodeDetail({ node, onClose }: { node: ExecutionNode; onClose: () => void }) {
  const meta = NODE_KIND_META[node.kind];
  const duration = formatDuration(node);
  const result = node.toolResult;

  return (
    <aside className="xdetail" aria-label={`Details for ${node.label}`}>
      <header className="xdetail-head">
        <div>
          <span className={`xdetail-kind xdetail-kind-${meta.tone}`}>{meta.label}</span>
          <h3>{node.label}</h3>
        </div>
        <button onClick={onClose} aria-label="Close node details">
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      <dl className="xdetail-facts">
        <div>
          <dt>Status</dt>
          <dd><StatusPill status={node.status} /></dd>
        </div>
        <div>
          <dt>Depth</dt>
          <dd>{node.depth}</dd>
        </div>
        {node.startedAt !== undefined && (
          <div>
            <dt>Started</dt>
            <dd>{formatClock(node.startedAt)}</dd>
          </div>
        )}
        {duration && (
          <div>
            <dt>Duration</dt>
            <dd>{duration}</dd>
          </div>
        )}
      </dl>

      <section className="xdetail-section">
        <h4>Detail</h4>
        <p>{node.detail}</p>
      </section>

      {node.toolCall && (
        <section className="xdetail-section">
          <h4>Tool call</h4>
          <p className="xdetail-tool">
            {node.toolCall.name}
            <ProviderChip node={node} />
          </p>
          {Object.keys(node.toolCall.input).length > 0 && (
            <pre className="xdetail-code">{JSON.stringify(node.toolCall.input, null, 2)}</pre>
          )}
        </section>
      )}

      {result && (
        <section className="xdetail-section">
          <h4>Result</h4>
          <p className={`xdetail-result xdetail-result-${result.status}`}>{result.status}</p>
          <p>{result.summary}</p>
          {result.signature && (
            <a
              className="xdetail-link"
              href={`https://explorer.solana.com/tx/${result.signature}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              View on Solana Explorer
              <ArrowSquareOut aria-hidden="true" size={13} />
            </a>
          )}
        </section>
      )}
    </aside>
  );
}

function StatusPill({ status }: { status: ExecutionNodeStatus }) {
  const Icon = status === "done" ? CheckCircle : status === "blocked" ? Prohibit : status === "running" ? Spinner : Circle;
  return (
    <span className={`xpill xpill-${status}`}>
      <Icon aria-hidden="true" size={12} weight="fill" />
      {status}
    </span>
  );
}

/* ------------------------------ execution log ------------------------------ */

interface ExecutionLogProps {
  readonly nodes: readonly ExecutionNode[];
  readonly ownerView: boolean;
  readonly onSelect: (id: string) => void;
}

export function ExecutionLog({ nodes, ownerView, onSelect }: ExecutionLogProps) {
  const entries = nodes
    .filter((node): node is ExecutionNode & { startedAt: number } => node.startedAt !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 40);

  return (
    <section className="xlog" aria-label="Execution log">
      <header className="xlog-head">
        <h3>Execution log</h3>
        <span>{entries.length} events</span>
      </header>
      {entries.length === 0 ? (
        <p className="xlog-empty">No steps have run yet. Send the agent a goal to start the graph.</p>
      ) : (
        <ol className="xlog-list">
          {entries.map((node) => (
            <li key={node.id}>
              <button onClick={() => onSelect(node.id)}>
                <span className="xlog-time">{formatClock(node.startedAt)}</span>
                <StatusPill status={node.status} />
                <span className="xlog-label">{node.label}</span>
                {ownerView ? (
                  <span className="xlog-detail">{node.toolResult?.summary ?? node.detail}</span>
                ) : (
                  <span className="xlog-detail xlog-redacted">
                    <LockKey aria-hidden="true" size={12} />
                    Withheld
                  </span>
                )}
                <span className="xlog-duration">{formatDuration(node) ?? "—"}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Attribution for a step whose data came from outside the chain. Renders
 * nothing for tools that have no external gateway, so ordinary nodes stay clean.
 */
function ProviderChip({
  node,
}: {
  node: Parameters<typeof toolProvider>[0];
}) {
  const provider = toolProvider(node);
  if (!provider) return null;
  return (
    <span className="xdetail-provider" title={`${provider.gateway} → ${provider.upstream}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={provider.gatewayLogo} alt="" width={12} height={12} />
      {provider.gateway}
      <span className="xdetail-provider-sep">›</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={provider.upstreamLogo} alt="" width={12} height={12} />
      {provider.upstream}
    </span>
  );
}
