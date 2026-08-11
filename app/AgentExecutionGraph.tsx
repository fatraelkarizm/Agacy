"use client";

import { useState } from "react";
import {
  Brain,
  CheckCircle,
  CursorClick,
  Eye,
  LockKey,
  PaperPlaneTilt,
  ShieldCheck,
  XCircle,
} from "@phosphor-icons/react";
import type {
  AgentRunEventKind,
  AuthorizedAgentRunEventDTO,
  PublicAgentRunEventDTO,
} from "../server/dto/agent-run.dto";
import { formatTokens } from "../server/services/demo-scenario";

type VisibleEvent = PublicAgentRunEventDTO | AuthorizedAgentRunEventDTO;

const NODE_LABEL: Record<AgentRunEventKind, string> = {
  goal: "Owner goal",
  observe: "Observe",
  decide: "Propose payment",
  policy: "Policy gate",
  execute: "Confirmed",
  refused: "Blocked",
};

interface AgentExecutionGraphProps {
  readonly publicEvents: readonly PublicAgentRunEventDTO[];
  readonly authorizedEvents: readonly AuthorizedAgentRunEventDTO[];
  readonly ownerView: boolean;
  readonly running: boolean;
}

export function AgentExecutionGraph(props: AgentExecutionGraphProps) {
  return props.ownerView ? (
    <GraphCanvas events={props.authorizedEvents} mode="owner" running={props.running} />
  ) : (
    <GraphCanvas events={props.publicEvents} mode="public" running={props.running} />
  );
}

function GraphCanvas({
  events,
  mode,
  running,
}: {
  events: readonly VisibleEvent[];
  mode: "public" | "owner";
  running: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = events.find((event) => event.id === selectedId) ?? events.at(-1);
  const goal = events.find((event) => event.kind === "goal");
  const taskIndexes = [...new Set(events.filter((event) => event.taskIndex >= 0).map((event) => event.taskIndex))];

  return (
    <section className="card execution-graph" aria-label="Agent execution graph" aria-busy={running}>
      <header className="execution-graph-head">
        <div>
          <div className="execution-graph-title">
            <span className={running ? "graph-live-indicator active" : "graph-live-indicator"} />
            Live execution graph
          </div>
          <p>Each node is emitted by the running service. Policy verdicts come from devnet.</p>
        </div>
        <span className={`graph-visibility graph-visibility-${mode}`}>
          {mode === "owner" ? <LockKey aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}
          {mode === "owner" ? "Authorized detail" : "Public observer"}
        </span>
      </header>

      <div className="execution-graph-body">
        <div className="execution-graph-scroll" aria-live="polite">
          {events.length === 0 ? (
            <div className="graph-empty">
              <Brain aria-hidden="true" size={30} weight="duotone" />
              <strong>Ready for an owner goal</strong>
              <p>Start the agent to watch its actions branch through the policy gate.</p>
            </div>
          ) : (
            <div className="execution-graph-canvas">
              {goal && (
                <div className="graph-goal-row">
                  <GraphNode event={goal} selected={selected?.id === goal.id} onSelect={setSelectedId} />
                </div>
              )}

              <div className="graph-task-stack">
                {taskIndexes.length === 0 && (
                  <article className="graph-task-lane graph-task-placeholder" aria-label="Queued execution path">
                    <span className="graph-branch-label">Waiting for live execution</span>
                    <div className="graph-node-track">
                      <PlaceholderNode kind="observe" label="Read task" />
                      <PlaceholderNode kind="decide" label="Choose action" />
                      <PlaceholderNode kind="policy" label="Check policy" />
                      <PlaceholderNode kind="execute" label="Confirm or block" />
                    </div>
                  </article>
                )}
                {taskIndexes.map((taskIndex) => {
                  const lane = events.filter((event) => event.taskIndex === taskIndex);
                  return (
                    <article className="graph-task-lane" key={taskIndex} aria-label={`Action branch ${taskIndex + 1}`}>
                      <span className="graph-branch-label">
                        {isAuthorized(lane[0]) ? lane[0].taskLabel : `Private action ${taskIndex + 1}`}
                      </span>
                      <div className="graph-node-track">
                        {lane.map((event) => (
                          <GraphNode
                            event={event}
                            key={event.id}
                            selected={selected?.id === event.id}
                            onSelect={setSelectedId}
                          />
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <GraphInspector event={selected} mode={mode} />
      </div>
    </section>
  );
}

function PlaceholderNode({ kind, label }: { kind: AgentRunEventKind; label: string }) {
  return (
    <div className="graph-node-wrap" aria-hidden="true">
      <div className="graph-node graph-node-placeholder">
        <span className="graph-node-icon">
          <NodeIcon kind={kind} />
        </span>
        <span className="graph-node-copy">
          <small>{NODE_LABEL[kind]}</small>
          <strong>{label}</strong>
        </span>
        <span className="graph-node-status">queued</span>
      </div>
    </div>
  );
}

function GraphNode({
  event,
  selected,
  onSelect,
}: {
  event: VisibleEvent;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="graph-node-wrap">
      <button
        className={`graph-node graph-node-${event.status}${selected ? " selected" : ""}`}
        onClick={() => onSelect(event.id)}
        aria-pressed={selected}
      >
        <span className="graph-node-icon">
          <NodeIcon kind={event.kind} />
        </span>
        <span className="graph-node-copy">
          <small>{NODE_LABEL[event.kind]}</small>
          <strong>{nodeSummary(event)}</strong>
        </span>
        <span className={`graph-node-status graph-node-status-${event.status}`}>{event.status}</span>
      </button>
    </div>
  );
}

function GraphInspector({ event, mode }: { event: VisibleEvent | undefined; mode: "public" | "owner" }) {
  if (!event) {
    return (
      <aside className="graph-inspector">
        <span className="graph-inspector-label">Node details</span>
        <p>Select a node after the run begins.</p>
      </aside>
    );
  }

  const authorized = isAuthorized(event) ? event : null;

  return (
    <aside className="graph-inspector">
      <span className="graph-inspector-label">Node details</span>
      <div className="graph-inspector-heading">
        <NodeIcon kind={event.kind} />
        <div>
          <strong>{NODE_LABEL[event.kind]}</strong>
          <span>{event.status}</span>
        </div>
      </div>

      <p>{authorized?.detail ?? publicDetail(event)}</p>

      {authorized && (
        <dl>
          {authorized.amount !== undefined && (
            <>
              <dt>Amount</dt>
              <dd>{formatTokens(authorized.amount)} USDC</dd>
            </>
          )}
          {authorized.recipient && (
            <>
              <dt>Recipient</dt>
              <dd>
                <code>{shortAddress(authorized.recipient)}</code>
              </dd>
            </>
          )}
          {authorized.taskLabel && (
            <>
              <dt>Task</dt>
              <dd>{authorized.taskLabel}</dd>
            </>
          )}
        </dl>
      )}

      {event.signature && (
        <a
          className="graph-proof-link"
          href={`https://explorer.solana.com/tx/${event.signature}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
        >
          Open devnet proof
          <PaperPlaneTilt aria-hidden="true" size={15} />
        </a>
      )}

      {mode === "public" && (
        <div className="graph-redaction-note">
          Goal, amount, recipient, and reasoning are not present in this public DTO.
        </div>
      )}
    </aside>
  );
}

function NodeIcon({ kind }: { kind: AgentRunEventKind }) {
  const props = { "aria-hidden": true, size: 18, weight: "duotone" as const };
  switch (kind) {
    case "goal":
      return <Brain {...props} />;
    case "observe":
      return <Eye {...props} />;
    case "decide":
      return <CursorClick {...props} />;
    case "policy":
      return <ShieldCheck {...props} />;
    case "execute":
      return <CheckCircle {...props} />;
    case "refused":
      return <XCircle {...props} />;
  }
}

function isAuthorized(event: VisibleEvent | undefined): event is AuthorizedAgentRunEventDTO {
  return Boolean(event && "detail" in event);
}

function nodeSummary(event: VisibleEvent): string {
  if (!isAuthorized(event)) return publicDetail(event);
  if (event.kind === "goal") return event.detail;
  if (event.kind === "decide" && event.amount !== undefined) return `${formatTokens(event.amount)} USDC`;
  if (event.kind === "observe" && event.taskLabel) return event.taskLabel;
  if (event.kind === "policy") return event.status === "running" ? "Checking devnet" : event.status;
  if (event.kind === "execute") return "Devnet confirmed";
  return event.detail;
}

function publicDetail(event: PublicAgentRunEventDTO): string {
  switch (event.kind) {
    case "goal":
      return "Owner instruction encrypted";
    case "observe":
      return "Private task observed";
    case "decide":
      return "Amount encrypted";
    case "policy":
      return event.status === "running" ? "Program checking" : `Policy ${event.status}`;
    case "execute":
      return "Transaction confirmed";
    case "refused":
      return "No funds moved";
  }
}

function shortAddress(value: string): string {
  return `${value.slice(0, 7)}...${value.slice(-5)}`;
}
