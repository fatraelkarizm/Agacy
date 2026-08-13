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
  AgentGraphToolCallDTO,
  AgentGraphToolName,
  AgentGraphChildDTO,
  AgentGraphExpansionDTO,
  AgentGraphNodeKind,
  AuthorizedAgentGraphToolResultDTO,
} from "../server/dto/agent-graph.dto";

type CanvasNodeKind = AgentGraphNodeKind | "goal";
type CanvasNodeStatus = "queued" | "running" | "done" | "blocked";

interface CanvasNode {
  readonly id: string;
  readonly parentId: string;
  readonly parentIds?: readonly string[];
  readonly label: string;
  readonly detail: string;
  readonly modelDetail?: string;
  readonly kind: CanvasNodeKind;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly expand: boolean;
  readonly status: CanvasNodeStatus;
  readonly toolCall?: AgentGraphToolCallDTO;
}

interface QueueItem {
  readonly node: CanvasNode;
  readonly lineage: readonly string[];
}

interface AgentGraphArenaProps {
  readonly onExit: () => void;
  readonly availableTools: readonly AgentGraphToolName[];
  readonly onToolCall: (
    call: AgentGraphToolCallDTO,
    ownerGoal: string,
  ) => Promise<AuthorizedAgentGraphToolResultDTO>;
}

const MAX_EXPANSION_REQUESTS = 8;
const MAX_NODES_PER_RUN = 36;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function AgentGraphArena({ availableTools, onExit, onToolCall }: AgentGraphArenaProps) {
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
    const angle = rootIndex * GOLDEN_ANGLE;
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
    const executedToolCalls = new Set<string>();
    const completedReadTools = new Set<AgentGraphToolName>();
    // What this run has actually established, carried across every branch.
    // Only `modelSummary` goes in here — never the owner-only `summary`.
    const verifiedObservations: string[] = [];
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
              detail: item.node.modelDetail ?? item.node.detail,
              kind: item.node.kind === "goal" ? "agent" : item.node.kind,
            },
            depth: item.node.depth,
            lineage: item.lineage,
            // Most recent first-hand facts win if the run is long enough to
            // exceed the server's cap, since later reads supersede earlier ones.
            observations: verifiedObservations.slice(-12),
            availableTools: availableTools.filter((tool) =>
              tool === "authorize_policy_spend" || !completedReadTools.has(tool)),
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

        const hasToolCalls = children.some((child) => child.toolCall);
        const toolResults: Array<{
          node: CanvasNode;
          result: AuthorizedAgentGraphToolResultDTO;
        }> = [];
        for (const child of children) {
          if (child.toolCall) {
            if (created >= MAX_NODES_PER_RUN) break;
            const fingerprint = JSON.stringify(child.toolCall);
            const toolResult = executedToolCalls.has(fingerprint)
              ? duplicateToolResult(child.toolCall)
              : await executeTool(child, child.toolCall, goal);
            executedToolCalls.add(fingerprint);
            if (child.toolCall.name !== "authorize_policy_spend") {
              completedReadTools.add(child.toolCall.name);
            }
            if (runIdRef.current !== runId) return;

            // Recorded whatever the outcome: a refusal ("that spend was over
            // the limit") is as much a verified fact as a successful read, and
            // is exactly what stops the model retrying the same dead end.
            verifiedObservations.push(
              `${child.toolCall.name} -> ${toolResult.status}: ${toolResult.modelSummary}`,
            );

            const resultNode = makeToolResultNode(child, toolResult);
            created += 1;
            setNodes((current) => [
              ...current.map((node) => node.id === child.id
                ? { ...node, status: toolResult.status === "succeeded" ? "done" as const : "blocked" as const }
                : node),
              resultNode,
            ]);
            setSelectedId(resultNode.id);
            setAnnouncement(resultNode.label);
            toolResults.push({ node: resultNode, result: toolResult });
            continue;
          }
          if (!hasToolCalls && child.expand && child.depth < 4) {
            queue.push({ node: child, lineage: [...item.lineage, child.label] });
          }
        }

        if (toolResults.length > 0 && created < MAX_NODES_PER_RUN) {
          const observation = makeToolObservationNode(toolResults);
          created += 1;
          setNodes((current) => [...current, observation]);
          setSelectedId(observation.id);
          // Every completed action continues the graph, including one that
          // failed or was blocked. Stopping on failure contradicted the
          // observation memory this run carries: refusals are recorded
          // precisely so the model can adapt, and it can only do that if it
          // gets another turn. A refusal is a fact to replan around ("that
          // recipient is off-policy, so report back") rather than the end of
          // the task.
          //
          // This cannot spin: the tool is removed from availableTools once it
          // has run, identical calls are blocked by fingerprint, and the depth,
          // request and node caps all still apply.
          if (observation.depth < 4) {
            queue.push({
              node: observation,
              lineage: [...item.lineage, observation.label],
            });
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

  const executeTool = async (node: CanvasNode, call: AgentGraphToolCallDTO, ownerGoal: string) => {
    updateNode(node.id, { status: "running" });
    setSelectedId(node.id);
    setAnnouncement(`Executing ${call.name}`);
    return onToolCall(call, ownerGoal);
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
        {nodes.flatMap((node) => (node.parentIds ?? [node.parentId]).flatMap((parentId) => {
          const parent = parentId === "agent-core"
            ? { x: 50, y: 50 }
            : nodes.find((candidate) => candidate.id === parentId);
          return parent ? [(
            <line
              className={`agent-canvas-edge agent-canvas-edge-${node.status}`}
              key={`edge-${parentId}-${node.id}`}
              x1={parent.x}
              y1={parent.y}
              x2={node.x}
              y2={node.y}
            />
          )] : [];
        }))}
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
      toolCall: child.toolCall,
      kind: child.kind,
      depth,
      x: clamp(parent.x + Math.cos(angle) * distance, 3, 97),
      y: clamp(parent.y + Math.sin(angle) * distance * 1.55, 4, 96),
      angle,
      expand: child.expand && depth < 4 && child.kind !== "blocked" && child.kind !== "complete",
      status: child.kind === "blocked" ? "blocked" : child.toolCall || child.expand ? "queued" : "done",
    };
  });
}

function makeToolResultNode(
  parent: CanvasNode,
  result: AuthorizedAgentGraphToolResultDTO,
): CanvasNode {
  const angle = parent.angle + (hashText(result.tool) % 2 === 0 ? 0.3 : -0.3);
  const succeeded = result.status === "succeeded";
  return {
    id: crypto.randomUUID(),
    parentId: parent.id,
    label: succeeded ? "Tool result" : result.status === "refused" ? "Policy refused" : "Tool blocked",
    detail: result.summary,
    modelDetail: result.modelSummary,
    kind: succeeded || result.status === "refused" ? "result" : "blocked",
    // Shares its tool node's depth rather than sitting a level below it.
    // `depth` gates how many more times the agent may plan, so it has to count
    // planning rounds; a result node is the bookkeeping for a round that has
    // already happened, not a new one. Charging it a level (and another for the
    // observation) spent three of the four allowed levels per single round of
    // tool use, which stopped the agent after two rounds with work still queued.
    depth: parent.depth,
    x: clamp(parent.x + Math.cos(angle) * 8, 3, 97),
    y: clamp(parent.y + Math.sin(angle) * 12, 4, 96),
    angle,
    expand: false,
    status: succeeded ? "done" : "blocked",
  };
}

function makeToolObservationNode(
  tools: ReadonlyArray<{
    readonly node: CanvasNode;
    readonly result: AuthorizedAgentGraphToolResultDTO;
  }>,
): CanvasNode {
  const x = tools.reduce((sum, item) => sum + item.node.x, 0) / tools.length;
  const y = tools.reduce((sum, item) => sum + item.node.y, 0) / tools.length;
  const angle = tools[0]?.node.angle ?? 0;
  return {
    id: crypto.randomUUID(),
    parentId: tools[0]?.node.id ?? "agent-core",
    parentIds: tools.map((item) => item.node.id),
    label: "Verified observations",
    detail: `${tools.length} tool result${tools.length === 1 ? "" : "s"} collected. Continue from verified data.`,
    modelDetail: tools.map((item) => item.result.modelSummary).join(" "),
    kind: "observe",
    // Same reasoning as makeToolResultNode: merging results is not itself a
    // planning round. The round is charged when this node is expanded.
    depth: Math.max(...tools.map((item) => item.node.depth)),
    x: clamp(x + Math.cos(angle) * 7, 3, 97),
    y: clamp(y + Math.sin(angle) * 10, 4, 96),
    angle,
    expand: true,
    status: "queued",
  };
}

function duplicateToolResult(call: AgentGraphToolCallDTO): AuthorizedAgentGraphToolResultDTO {
  return {
    tool: call.name,
    status: "blocked",
    summary: "The same tool call already ran in this task, so the duplicate was blocked.",
    modelSummary: "A duplicate tool call was blocked to prevent repeated side effects.",
  };
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
