"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import type {
  AgentGraphChildDTO,
  AgentGraphExpansionDTO,
  AgentGraphNodeKind,
} from "../server/dto/agent-graph.dto";

type CanvasNodeKind = AgentGraphNodeKind | "goal";
type CanvasNodeStatus = "queued" | "running" | "done" | "blocked";

interface CanvasNode {
  readonly id: string;
  readonly parentId: string;
  readonly label: string;
  readonly detail: string;
  readonly kind: CanvasNodeKind;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly expand: boolean;
  readonly status: CanvasNodeStatus;
}

interface QueueItem {
  readonly node: CanvasNode;
  readonly lineage: readonly string[];
}

interface AgentGraphArenaProps {
  readonly onExit: () => void;
}

const MAX_EXPANSION_REQUESTS = 8;
const MAX_NODES_PER_RUN = 36;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function AgentGraphArena({ onExit }: AgentGraphArenaProps) {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState("agent-core");
  const [announcement, setAnnouncement] = useState("AI Agent ready");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (composerOpen) textareaRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (composerOpen) setComposerOpen(false);
      else onExit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composerOpen, onExit]);

  useEffect(() => () => {
    runIdRef.current += 1;
  }, []);

  const openComposer = (event?: ReactMouseEvent) => {
    event?.preventDefault();
    setComposerOpen(true);
  };

  const submitCommand = (event: FormEvent) => {
    event.preventDefault();
    const goal = command.trim();
    if (!goal || running) return;

    const runId = ++runIdRef.current;
    const rootIndex = nodes.filter((node) => node.kind === "goal").length;
    const angle = -Math.PI / 2 + rootIndex * GOLDEN_ANGLE;
    const root = makeGoalNode(goal, angle);

    setNodes((current) => [...current, root]);
    setSelectedId(root.id);
    setCommand("");
    setComposerOpen(false);
    setRunning(true);
    setAnnouncement(`AI Agent received: ${goal}`);
    void growGraph(root, goal, runId).finally(() => {
      if (runIdRef.current === runId) setRunning(false);
    });
  };

  const growGraph = async (root: CanvasNode, goal: string, runId: number) => {
    const queue: QueueItem[] = [{ node: root, lineage: [root.label] }];
    let requests = 0;
    let created = 0;

    while (
      queue.length > 0 &&
      requests < MAX_EXPANSION_REQUESTS &&
      created < MAX_NODES_PER_RUN &&
      runIdRef.current === runId
    ) {
      const item = queue.shift();
      if (!item) break;
      requests += 1;
      updateNode(item.node.id, { status: "running" });
      setSelectedId(item.node.id);
      setAnnouncement(`Expanding ${item.node.label}`);

      try {
        const response = await fetch("/api/agent/graph", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            goal,
            parent: {
              label: item.node.label,
              detail: item.node.detail,
              kind: item.node.kind === "goal" ? "agent" : item.node.kind,
            },
            depth: item.node.depth,
            lineage: item.lineage,
          }),
        });
        const payload = await response.json() as AgentGraphExpansionDTO | { error: string };
        if (!response.ok || !("children" in payload)) {
          throw new Error("error" in payload ? payload.error : "Graph expansion failed");
        }
        if (runIdRef.current !== runId) return;

        const children = placeChildren(
          item.node,
          payload.children.slice(0, MAX_NODES_PER_RUN - created),
        );
        created += children.length;
        setNodes((current) => [
          ...current.map((node) => node.id === item.node.id ? { ...node, status: "done" as const } : node),
          ...children,
        ]);

        for (const child of children) {
          if (child.expand && child.depth < 4) {
            queue.push({ node: child, lineage: [...item.lineage, child.label] });
          }
        }
      } catch (error) {
        const blocked = makeBlockedNode(item.node, error instanceof Error ? error.message : "Expansion failed");
        setNodes((current) => [
          ...current.map((node) => node.id === item.node.id ? { ...node, status: "blocked" as const } : node),
          blocked,
        ]);
        setSelectedId(blocked.id);
        setAnnouncement(blocked.detail);
      }
    }

    if (runIdRef.current === runId) {
      setAnnouncement(queue.length > 0 ? "Agent stopped at its execution limit" : "Agent task graph complete");
    }
  };

  const updateNode = (id: string, patch: Partial<Pick<CanvasNode, "status">>) => {
    setNodes((current) => current.map((node) => node.id === id ? { ...node, ...patch } : node));
  };

  const selected = nodes.find((node) => node.id === selectedId);

  return (
    <main
      className="agent-canvas"
      onContextMenu={openComposer}
      onClick={(event) => {
        if (event.target === event.currentTarget) setSelectedId("agent-core");
      }}
    >
      <svg className="agent-canvas-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {nodes.map((node) => {
          const parent = node.parentId === "agent-core"
            ? { x: 50, y: 50 }
            : nodes.find((candidate) => candidate.id === node.parentId);
          if (!parent) return null;
          return (
            <line
              className={`agent-canvas-edge agent-canvas-edge-${node.status}`}
              key={`edge-${node.id}`}
              x1={parent.x}
              y1={parent.y}
              x2={node.x}
              y2={node.y}
            />
          );
        })}
      </svg>

      <button
        className={`agent-canvas-core${running ? " running" : ""}${selectedId === "agent-core" ? " selected" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          setSelectedId("agent-core");
          openComposer();
        }}
        aria-label="AI Agent. Open owner command input"
      >
        AI Agent
      </button>

      {nodes.map((node) => (
        <button
          className={`agent-canvas-node agent-canvas-node-${node.kind} agent-canvas-node-${node.status}${node.x > 76 ? " edge-right" : ""}${selectedId === node.id ? " selected" : ""}`}
          key={node.id}
          style={{ "--node-x": `${node.x}%`, "--node-y": `${node.y}%`, "--node-depth": node.depth } as CSSProperties}
          onClick={(event) => {
            event.stopPropagation();
            setSelectedId(node.id);
          }}
          aria-label={`${node.label}. ${node.detail}. ${node.status}`}
        >
          <span className="agent-canvas-node-dot" />
          <span className="agent-canvas-node-label">{node.label}</span>
        </button>
      ))}

      {selected && (
        <aside
          className={`agent-canvas-detail${selected.x > 76 ? " edge-right" : ""}`}
          style={{ "--detail-x": `${selected.x}%`, "--detail-y": `${selected.y}%` } as CSSProperties}
        >
          <strong>{selected.label}</strong>
          <p>{selected.detail}</p>
        </aside>
      )}

      {composerOpen && (
        <form className="agent-canvas-composer" onSubmit={submitCommand} onClick={(event) => event.stopPropagation()}>
          <textarea
            ref={textareaRef}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="What should the agent do?"
            rows={5}
            disabled={running}
            aria-label="Owner command"
          />
          <button type="submit" disabled={!command.trim() || running} aria-label="Send command to AI Agent">
            <PaperPlaneTilt aria-hidden="true" size={20} weight="fill" />
          </button>
        </form>
      )}

      <p className="agent-canvas-live" aria-live="polite">{announcement}</p>
    </main>
  );
}

function makeGoalNode(goal: string, angle: number): CanvasNode {
  return {
    id: crypto.randomUUID(),
    parentId: "agent-core",
    label: compactLabel(goal),
    detail: goal,
    kind: "goal",
    depth: 0,
    x: clamp(50 + Math.cos(angle) * 15, 5, 95),
    y: clamp(50 + Math.sin(angle) * 23, 7, 93),
    angle,
    expand: true,
    status: "queued",
  };
}

function placeChildren(parent: CanvasNode, children: readonly AgentGraphChildDTO[]): CanvasNode[] {
  const count = children.length;
  const distance = Math.max(7, 13 - parent.depth * 1.4);
  const spread = parent.depth === 0 ? 1.45 : 1.05;

  return children.map((child, index) => {
    const offset = count === 1 ? 0 : (index / (count - 1) - 0.5) * spread;
    const jitter = (hashText(child.label) % 19 - 9) / 100;
    const angle = parent.angle + offset + jitter;
    const depth = parent.depth + 1;
    return {
      id: crypto.randomUUID(),
      parentId: parent.id,
      label: child.label,
      detail: child.detail,
      kind: child.kind,
      depth,
      x: clamp(parent.x + Math.cos(angle) * distance, 3, 97),
      y: clamp(parent.y + Math.sin(angle) * distance * 1.55, 4, 96),
      angle,
      expand: child.expand && depth < 4 && child.kind !== "blocked" && child.kind !== "complete",
      status: child.kind === "blocked" ? "blocked" : child.expand ? "queued" : "done",
    };
  });
}

function makeBlockedNode(parent: CanvasNode, detail: string): CanvasNode {
  const angle = parent.angle + 0.35;
  return {
    id: crypto.randomUUID(),
    parentId: parent.id,
    label: "Blocked",
    detail,
    kind: "blocked",
    depth: parent.depth + 1,
    x: clamp(parent.x + Math.cos(angle) * 8, 3, 97),
    y: clamp(parent.y + Math.sin(angle) * 12, 4, 96),
    angle,
    expand: false,
    status: "blocked",
  };
}

function compactLabel(goal: string): string {
  const words = goal.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, 5).join(" ") + (words.length > 5 ? "..." : "");
}

function hashText(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
