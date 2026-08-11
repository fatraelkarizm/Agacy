"use client";

import { useState } from "react";
import {
  Brain,
  CheckCircle,
  CursorClick,
  Eye,
  LockKey,
  PaperPlaneTilt,
  Robot,
  ShieldCheck,
  XCircle,
} from "@phosphor-icons/react";
import type {
  AgentRunEventKind,
  AgentRunEventStatus,
  AuthorizedAgentRunEventDTO,
  PublicAgentRunEventDTO,
} from "../server/dto/agent-run.dto";
import { formatTokens } from "../server/services/demo-scenario";

type VisibleEvent = PublicAgentRunEventDTO | AuthorizedAgentRunEventDTO;
type Branch = "a" | "b" | "c";
type Slot =
  | "goal"
  | `${Branch}-observe`
  | `${Branch}-decide`
  | `${Branch}-policy`
  | `${Branch}-outcome`;

const NODE_LABEL: Record<AgentRunEventKind, string> = {
  goal: "Owner goal",
  observe: "Worker",
  decide: "Action",
  policy: "Policy",
  execute: "Confirmed",
  refused: "Blocked",
};

const KIND_ORDER: Record<AgentRunEventKind, number> = {
  goal: 0,
  observe: 1,
  decide: 2,
  policy: 3,
  execute: 4,
  refused: 4,
};

const SLOT_POSITION: Record<Slot | "core", readonly [number, number]> = {
  core: [50, 50],
  goal: [50, 9],
  "a-observe": [38, 46],
  "a-decide": [28, 41],
  "a-policy": [17, 36],
  "a-outcome": [7, 31],
  "b-observe": [62, 46],
  "b-decide": [72, 41],
  "b-policy": [83, 36],
  "b-outcome": [93, 31],
  "c-observe": [50, 63],
  "c-decide": [50, 73],
  "c-policy": [50, 82],
  "c-outcome": [50, 91],
};

interface AgentExecutionGraphProps {
  readonly agentName: string;
  readonly agentAddress?: string;
  readonly publicEvents: readonly PublicAgentRunEventDTO[];
  readonly authorizedEvents: readonly AuthorizedAgentRunEventDTO[];
  readonly ownerView: boolean;
  readonly running: boolean;
}

export function AgentExecutionGraph(props: AgentExecutionGraphProps) {
  const events = props.ownerView ? props.authorizedEvents : props.publicEvents;

  return (
    <SwarmCanvas
      agentName={props.agentName}
      agentAddress={props.agentAddress}
      events={events}
      mode={props.ownerView ? "owner" : "public"}
      running={props.running}
    />
  );
}

function SwarmCanvas({
  agentName,
  agentAddress,
  events,
  mode,
  running,
}: {
  agentName: string;
  agentAddress?: string;
  events: readonly VisibleEvent[];
  mode: "public" | "owner";
  running: boolean;
}) {
  const [selectedId, setSelectedId] = useState("agent-core");
  const taskIndexes = [...new Set(events.filter((event) => event.taskIndex >= 0).map((event) => event.taskIndex))];
  const selected = events.find((event) => event.id === selectedId) ?? events.at(-1);
  const edges = buildEdges(events, taskIndexes);

  return (
    <section className="swarm-shell" aria-label="Agent swarm graph" aria-busy={running}>
      <header className="swarm-head">
        <div>
          <h2>Live agent swarm</h2>
          <p>One agent fans work out. Every branch must cross the on-chain policy before settlement.</p>
        </div>
        <span className={`swarm-visibility swarm-visibility-${mode}`}>
          {mode === "owner" ? <LockKey aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}
          {mode === "owner" ? "Owner detail" : "Public redaction"}
        </span>
      </header>

      <div className="swarm-layout">
        <div className="swarm-viewport" aria-live="polite">
          <div className="swarm-canvas">
            <svg className="swarm-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {edges.map((edge) => (
                <line
                  className={`swarm-edge swarm-edge-${edge.status}`}
                  key={edge.id}
                  x1={edge.from[0]}
                  y1={edge.from[1]}
                  x2={edge.to[0]}
                  y2={edge.to[1]}
                />
              ))}
            </svg>

            <button
              className={`swarm-core${running ? " active" : ""}${selectedId === "agent-core" ? " selected" : ""}`}
              onClick={() => setSelectedId("agent-core")}
              aria-pressed={selectedId === "agent-core"}
            >
              <Robot aria-hidden="true" size={27} weight="duotone" />
              <strong>{agentName}</strong>
              <span>{running ? "dispatching" : "policy-scoped"}</span>
            </button>

            {taskIndexes.length === 0 && <DormantSwarm />}

            {events.map((event) => (
              <SwarmNode
                event={event}
                key={event.id}
                selected={selected?.id === event.id && selectedId !== "agent-core"}
                slot={slotForEvent(event, taskIndexes)}
                onSelect={setSelectedId}
              />
            ))}
          </div>
        </div>

        <SwarmInspector
          agentAddress={agentAddress}
          agentName={agentName}
          event={selectedId === "agent-core" ? undefined : selected}
          mode={mode}
        />
      </div>
    </section>
  );
}

function DormantSwarm() {
  return (
    <div className="swarm-dormant" aria-hidden="true">
      <span className="swarm-placeholder swarm-slot-a-observe">Worker A</span>
      <span className="swarm-placeholder swarm-slot-a-decide">Choose action</span>
      <span className="swarm-placeholder swarm-slot-a-policy">Policy gate</span>
      <span className="swarm-placeholder swarm-slot-a-outcome">Settlement</span>
      <span className="swarm-placeholder swarm-slot-b-observe">Worker B</span>
      <span className="swarm-placeholder swarm-slot-b-decide">Choose action</span>
      <span className="swarm-placeholder swarm-slot-b-policy">Policy gate</span>
      <span className="swarm-placeholder swarm-slot-b-outcome">Settlement</span>
      <span className="swarm-placeholder swarm-slot-c-observe">Worker C</span>
      <span className="swarm-placeholder swarm-slot-c-decide">Choose action</span>
      <span className="swarm-placeholder swarm-slot-c-policy">Policy gate</span>
      <span className="swarm-placeholder swarm-slot-c-outcome">Solana devnet</span>
    </div>
  );
}

function SwarmNode({
  event,
  selected,
  slot,
  onSelect,
}: {
  event: VisibleEvent;
  selected: boolean;
  slot: Slot;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={`swarm-node swarm-slot-${slot} swarm-node-${event.status}${selected ? " selected" : ""}`}
      onClick={() => onSelect(event.id)}
      aria-pressed={selected}
    >
      <span className="swarm-node-icon">
        <NodeIcon kind={event.kind} />
      </span>
      <span className="swarm-node-copy">
        <small>{NODE_LABEL[event.kind]}</small>
        <strong>{nodeSummary(event)}</strong>
      </span>
      <span className="swarm-node-status">{event.status}</span>
    </button>
  );
}

function SwarmInspector({
  agentAddress,
  agentName,
  event,
  mode,
}: {
  agentAddress?: string;
  agentName: string;
  event: VisibleEvent | undefined;
  mode: "public" | "owner";
}) {
  if (!event) {
    return (
      <aside className="swarm-inspector">
        <span className="swarm-inspector-label">Selected node</span>
        <div className="swarm-inspector-heading">
          <Robot aria-hidden="true" size={20} weight="duotone" />
          <div><strong>{agentName}</strong><span>Session agent</span></div>
        </div>
        <p>Receives one owner mandate, then signs every in-policy action with its own session key.</p>
        <dl>
          <dt>Wallet prompts</dt><dd>0 during run</dd>
          <dt>Authority</dt><dd>Policy-scoped</dd>
          {agentAddress && <><dt>Agent</dt><dd><code>{shortAddress(agentAddress)}</code></dd></>}
        </dl>
      </aside>
    );
  }

  const authorized = isAuthorized(event) ? event : null;

  return (
    <aside className="swarm-inspector">
      <span className="swarm-inspector-label">Selected node</span>
      <div className="swarm-inspector-heading">
        <NodeIcon kind={event.kind} />
        <div><strong>{NODE_LABEL[event.kind]}</strong><span>{event.status}</span></div>
      </div>
      <p>{authorized?.detail ?? publicDetail(event)}</p>

      {authorized && (
        <dl>
          {authorized.amount !== undefined && <><dt>Amount</dt><dd>{formatTokens(authorized.amount)} USDC</dd></>}
          {authorized.recipient && <><dt>Recipient</dt><dd><code>{shortAddress(authorized.recipient)}</code></dd></>}
          {authorized.taskLabel && <><dt>Task</dt><dd>{authorized.taskLabel}</dd></>}
        </dl>
      )}

      {event.signature && (
        <a
          className="swarm-proof-link"
          href={`https://explorer.solana.com/tx/${event.signature}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
        >
          Open devnet proof
          <PaperPlaneTilt aria-hidden="true" size={15} />
        </a>
      )}

      {mode === "public" && (
        <p className="swarm-redaction-note">Goal, amount, recipient, and reasoning do not enter the public DTO.</p>
      )}
    </aside>
  );
}

function buildEdges(events: readonly VisibleEvent[], taskIndexes: readonly number[]) {
  const edges: Array<{
    id: string;
    from: readonly [number, number];
    to: readonly [number, number];
    status: AgentRunEventStatus | "dormant";
  }> = [];
  const goal = events.find((event) => event.kind === "goal");

  if (goal) {
    edges.push({ id: "goal-core", from: SLOT_POSITION.goal, to: SLOT_POSITION.core, status: goal.status });
  }

  if (taskIndexes.length === 0) {
    for (const branch of ["a", "b", "c"] as const) {
      let from = SLOT_POSITION.core;
      for (const stage of ["observe", "decide", "policy", "outcome"] as const) {
        const slot = `${branch}-${stage}` as Slot;
        const to = SLOT_POSITION[slot];
        edges.push({ id: `dormant-${slot}`, from, to, status: "dormant" });
        from = to;
      }
    }
    return edges;
  }

  for (const taskIndex of taskIndexes) {
    const lane = events
      .filter((event) => event.taskIndex === taskIndex)
      .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
    let from = SLOT_POSITION.core;
    for (const event of lane) {
      const to = SLOT_POSITION[slotForEvent(event, taskIndexes)];
      edges.push({ id: `edge-${event.id}`, from, to, status: event.status });
      from = to;
    }
  }

  return edges;
}

function slotForEvent(event: VisibleEvent, taskIndexes: readonly number[]): Slot {
  if (event.kind === "goal") return "goal";
  const branches = ["a", "b", "c"] as const;
  const branch = branches[Math.max(0, taskIndexes.indexOf(event.taskIndex)) % branches.length] ?? "c";
  const stage = event.kind === "execute" || event.kind === "refused" ? "outcome" : event.kind;
  return `${branch}-${stage}`;
}

function NodeIcon({ kind }: { kind: AgentRunEventKind }) {
  const props = { "aria-hidden": true, size: 18, weight: "duotone" as const };
  switch (kind) {
    case "goal": return <Brain {...props} />;
    case "observe": return <Eye {...props} />;
    case "decide": return <CursorClick {...props} />;
    case "policy": return <ShieldCheck {...props} />;
    case "execute": return <CheckCircle {...props} />;
    case "refused": return <XCircle {...props} />;
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
    case "goal": return "Owner instruction encrypted";
    case "observe": return "Private task observed";
    case "decide": return "Amount encrypted";
    case "policy": return event.status === "running" ? "Program checking" : `Policy ${event.status}`;
    case "execute": return "Transaction confirmed";
    case "refused": return "No funds moved";
  }
}

function shortAddress(value: string): string {
  return `${value.slice(0, 7)}...${value.slice(-5)}`;
}
