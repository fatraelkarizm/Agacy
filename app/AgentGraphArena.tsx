"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowsOut,
  Crosshair,
  Eye,
  EyeSlash,
  LockKey,
  LockKeyOpen,
  MagnifyingGlassPlus,
  PaperPlaneTilt,
  Plus,
} from "@phosphor-icons/react";
import type {
  AgentGraphToolCallDTO,
  AgentGraphToolName,
  AgentGraphChildDTO,
  AgentGraphExpansionDTO,
  AuthorizedAgentGraphToolResultDTO,
} from "../server/dto/agent-graph.dto";
import { ExecutionGraphCanvas } from "./ExecutionGraphCanvas";
import {
  ExecutionLog,
  GraphStats,
  ModelBoundaryPanel,
  NodeDetailPanel,
} from "./ExecutionGraphPanels";
import { AGENT_CORE_ID, type ExecutionNode } from "./execution-graph-model";

interface QueueItem {
  readonly node: ExecutionNode;
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

export function AgentGraphArena({ availableTools, onExit, onToolCall }: AgentGraphArenaProps) {
  const [nodes, setNodes] = useState<ExecutionNode[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  /*
    Public is the default. The redacted view is the honest one, so it should be
    what anyone sees first — including the owner, who then has to deliberately
    ask for the private detail rather than being handed it by accident while
    presenting.
  */
  const [ownerView, setOwnerView] = useState(false);
  /*
    Owner-controlled payment mode. Confidential by default: the safe setting
    must be the one you get by not choosing.
  */
  const [paymentMode, setPaymentMode] = useState<"confidential" | "public">("confidential");
  const paymentModeRef = useRef<"confidential" | "public">("confidential");
  const [goal, setGoal] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("AI Agent ready");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const runIdRef = useRef(0);
  const followRef = useRef(true);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  // Read from a ref inside growGraph so a mid-run toggle cannot retarget a
  // payment the owner already set in motion.
  useEffect(() => {
    paymentModeRef.current = paymentMode;
  }, [paymentMode]);

  useEffect(() => {
    if (composerOpen) textareaRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Unwinds one layer at a time, widest context last: the composer, then
      // focus mode, then the selection, and only then the graph itself.
      // Escape should never drop the owner further out than they expect.
      if (composerOpen) setComposerOpen(false);
      else if (focusMode) setFocusMode(false);
      else if (selectedId) setSelectedId(null);
      else onExit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composerOpen, focusMode, onExit, selectedId]);

  // Only ticks while a run is in flight, so an idle graph is not re-rendering
  // once a second for a clock nobody is watching.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => () => {
    runIdRef.current += 1;
  }, []);

  const patchNode = useCallback((id: string, patch: Partial<ExecutionNode>) => {
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, ...patch } : node)));
  }, []);

  /** Auto-selection follows the active node only while Follow is on. */
  const focusNode = useCallback((id: string) => {
    if (followRef.current) setSelectedId(id);
  }, []);

  const growGraph = useCallback(
    async (root: ExecutionNode, ownerGoal: string, runId: number) => {
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
        patchNode(item.node.id, { status: "running", startedAt: Date.now() });
        focusNode(item.node.id);
        setAnnouncement(`Expanding ${item.node.label}`);

        try {
          const response = await fetch("/api/agent/graph", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              goal: ownerGoal,
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
              // Sent as well as filtered. Removing a finished tool without
              // saying so left the model to infer an absence it was never told
              // about: it asked again, the request came back as an "unavailable"
              // node, and a run whose payment had already succeeded ended on a
              // red refusal. Naming them is what stops the re-ask.
              completedTools: [...completedReadTools],
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
            ...current.map((node) => node.id === item.node.id
              ? { ...node, status: "done" as const, endedAt: Date.now() }
              : node),
            ...children,
          ]);

          const hasToolCalls = children.some((child) => child.toolCall);
          const toolResults: Array<{
            node: ExecutionNode;
            result: AuthorizedAgentGraphToolResultDTO;
          }> = [];
          for (const child of children) {
            if (child.toolCall) {
              if (created >= MAX_NODES_PER_RUN) break;
              /*
                The owner's payment mode is stamped here, overwriting whatever
                the model asked for. Whether an amount is published is an
                authority decision, not a planning one — the same reason the
                spend limit lives in a program rather than in the prompt. A
                prompt-injected agent must not be able to choose to publish.
              */
              const call: AgentGraphToolCallDTO = child.toolCall.name === "pay_confidentially"
                ? {
                    name: "pay_confidentially",
                    input: {
                      amountTokens: child.toolCall.input.amountTokens,
                      mode: paymentModeRef.current,
                    },
                  }
                : child.toolCall;
              const fingerprint = JSON.stringify(call);
              const startedTool = Date.now();
              patchNode(child.id, { status: "running", startedAt: startedTool, toolCall: call });
              focusNode(child.id);
              setAnnouncement(`Executing ${call.name}`);
              const toolResult = executedToolCalls.has(fingerprint)
                ? duplicateToolResult(call)
                : await onToolCall(call, ownerGoal);
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
                  ? {
                      ...node,
                      status: toolResult.status === "succeeded" ? "done" as const : "blocked" as const,
                      endedAt: Date.now(),
                      toolResult,
                    }
                  : node),
                resultNode,
              ]);
              focusNode(resultNode.id);
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
            focusNode(observation.id);
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
            ...current.map((node) => node.id === item.node.id
              ? { ...node, status: "blocked" as const, endedAt: Date.now() }
              : node),
            blocked,
          ]);
          focusNode(blocked.id);
          setAnnouncement(blocked.detail);
        }
      }

      if (runIdRef.current === runId) {
        setAnnouncement(queue.length > 0 ? "Agent stopped at its execution limit" : "Agent task graph complete");
      }
    },
    [availableTools, focusNode, onToolCall, patchNode],
  );

  const submitCommand = (event: FormEvent) => {
    event.preventDefault();
    const nextGoal = command.trim();
    if (!nextGoal || running) return;

    const runId = ++runIdRef.current;
    const root = makeGoalNode(nextGoal);

    setNodes((current) => [...current, root]);
    setGoal(nextGoal);
    setSelectedId(root.id);
    setFollow(true);
    setCommand("");
    setComposerOpen(false);
    setRunning(true);
    setStartedAt((current) => current ?? Date.now());
    setNow(Date.now());
    setAnnouncement(`AI Agent received: ${nextGoal}`);
    void growGraph(root, nextGoal, runId).finally(() => {
      if (runIdRef.current === runId) setRunning(false);
    });
  };

  const selected = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const elapsedLabel = useMemo(() => {
    if (startedAt === null) return "";
    const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s elapsed` : `${seconds}s elapsed`;
  }, [now, startedAt]);

  return (
    <div className={`xgraph${selected ? " has-detail" : ""}${focusMode ? " is-focus" : ""}`}>
      <header className="xgraph-head">
        <div className="xgraph-title">
          <h2>Execution Graph</h2>
          <span className={`xgraph-live${running ? " is-running" : ""}`}>
            <span aria-hidden="true" />
            {running ? "Live" : nodes.length > 0 ? "Idle" : "Ready"}
          </span>
        </div>
        <p className="xgraph-goal">{goal ? `Goal: ${goal}` : "No goal sent yet."}</p>
        <div className="xgraph-actions">
          {/*
            Payment mode, not view mode. This decides what actually lands
            on-chain, so it sits next to the other run controls rather than
            hiding in a settings pane — and it is the owner's switch, never the
            model's.
          */}
          <div className="xmode" role="group" aria-label="Payment mode">
            <button
              className={paymentMode === "confidential" ? "is-on" : ""}
              onClick={() => setPaymentMode("confidential")}
              aria-pressed={paymentMode === "confidential"}
              disabled={running}
            >
              <LockKey aria-hidden="true" size={14} weight="duotone" />
              Confidential
            </button>
            <button
              className={paymentMode === "public" ? "is-on is-public" : ""}
              onClick={() => setPaymentMode("public")}
              aria-pressed={paymentMode === "public"}
              disabled={running}
            >
              <LockKeyOpen aria-hidden="true" size={14} weight="duotone" />
              Public
            </button>
          </div>
          <button
            className={ownerView ? "is-active" : ""}
            onClick={() => setOwnerView((value) => !value)}
            aria-pressed={ownerView}
            title="Switch between what a public observer sees and the owner's decrypted view"
          >
            {ownerView
              ? <EyeSlash aria-hidden="true" size={15} weight="duotone" />
              : <Eye aria-hidden="true" size={15} weight="duotone" />}
            {ownerView ? "Hide owner view" : "Reveal owner view"}
          </button>
          <button
            className={focusMode ? "is-active" : ""}
            onClick={() => setFocusMode((value) => !value)}
            aria-pressed={focusMode}
            disabled={nodes.length === 0}
            title="Fill the workspace and dim everything off the selected path"
          >
            <MagnifyingGlassPlus aria-hidden="true" size={15} weight="duotone" />
            Focus
          </button>
          <button
            className={follow ? "is-active" : ""}
            onClick={() => setFollow((value) => !value)}
            aria-pressed={follow}
            title="Keep the newest node in view"
          >
            <Crosshair aria-hidden="true" size={15} weight="duotone" />
            Follow
          </button>
          <button onClick={onExit} title="Back to the dashboard overview">
            <ArrowsOut aria-hidden="true" size={15} weight="duotone" />
            Exit graph
          </button>
          <button className="primary" onClick={() => setComposerOpen(true)} disabled={running}>
            <Plus aria-hidden="true" size={15} weight="duotone" />
            New goal
          </button>
        </div>
      </header>

      <GraphStats
        nodes={nodes}
        running={running}
        startedAt={startedAt}
        elapsedLabel={elapsedLabel}
        ownerView={ownerView}
      />

      <div className="xgraph-stage">
        <div className="xgraph-main">
          {nodes.length === 0 && !composerOpen ? (
            <div className="xgraph-empty">
              <h3>The graph is empty.</h3>
              <p>
                Give the agent a goal. It expands into observations, tool calls and policy checks,
                and every completed action opens the next step.
              </p>
              <button className="primary" onClick={() => setComposerOpen(true)}>
                <Plus aria-hidden="true" size={15} weight="duotone" />
                Send the first goal
              </button>
            </div>
          ) : (
            <ExecutionGraphCanvas
              nodes={nodes}
              selectedId={selectedId ?? ""}
              running={running}
              followActive={follow}
              focusMode={focusMode}
              onSelect={(id) => {
                if (id === AGENT_CORE_ID) {
                  setComposerOpen(true);
                  return;
                }
                setFollow(false);
                setSelectedId(id);
              }}
              onRequestGoal={() => setComposerOpen(true)}
            />
          )}

          <ExecutionLog
            nodes={nodes}
            ownerView={ownerView}
            onSelect={(id) => {
              setFollow(false);
              setSelectedId(id);
            }}
          />

          {!focusMode && <ModelBoundaryPanel />}
        </div>

        {selected && (
          <NodeDetailPanel
            node={selected}
            ownerView={ownerView}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {composerOpen && (
        <div className="xcomposer-scrim" onClick={() => setComposerOpen(false)}>
          <form
            className="xcomposer"
            onSubmit={submitCommand}
            onClick={(event) => event.stopPropagation()}
          >
            <label htmlFor="owner-command">What should the agent do?</label>
            <textarea
              id="owner-command"
              ref={textareaRef}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Price SOL and quote a 25 USDC swap before I commit."
              rows={4}
              disabled={running}
            />
            <div className="xcomposer-foot">
              <span>Enter to send · Shift+Enter for a new line</span>
              <button type="submit" disabled={!command.trim() || running}>
                <PaperPlaneTilt aria-hidden="true" size={16} weight="fill" />
                Send
              </button>
            </div>
          </form>
        </div>
      )}

      <p className="xgraph-live-region" aria-live="polite">{announcement}</p>
    </div>
  );
}

/* ------------------------------ node factories ----------------------------- */

function makeGoalNode(goal: string): ExecutionNode {
  return {
    id: crypto.randomUUID(),
    parentId: AGENT_CORE_ID,
    label: compactLabel(goal),
    detail: goal,
    kind: "goal",
    depth: 0,
    column: 1,
    expand: true,
    status: "queued",
  };
}

function placeChildren(
  parent: ExecutionNode,
  children: readonly AgentGraphChildDTO[],
): ExecutionNode[] {
  return children.map((child) => {
    const depth = parent.depth + 1;
    return {
      id: crypto.randomUUID(),
      parentId: parent.id,
      label: child.label,
      detail: child.detail,
      ...(child.toolCall ? { toolCall: child.toolCall } : {}),
      kind: child.kind,
      depth,
      column: parent.column + 1,
      expand: child.expand && depth < 4 && child.kind !== "blocked" && child.kind !== "complete",
      status: child.kind === "blocked"
        ? ("blocked" as const)
        : child.toolCall || child.expand
          ? ("queued" as const)
          : ("done" as const),
    };
  });
}

function makeToolResultNode(
  parent: ExecutionNode,
  result: AuthorizedAgentGraphToolResultDTO,
): ExecutionNode {
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
    // Layout is a separate axis from the planning budget: a result still reads
    // as a step to the right of the tool that produced it.
    column: parent.column + 1,
    expand: false,
    status: succeeded ? "done" : "blocked",
    toolResult: result,
    // Timestamped so it sorts into the log, but deliberately left without an
    // end: this node is created the instant its tool returns, so any duration
    // it reported would be a rounded-to-zero fiction rather than measured work.
    // The real elapsed time lives on the tool node that made the call.
    startedAt: Date.now(),
  };
}

function makeToolObservationNode(
  tools: ReadonlyArray<{
    readonly node: ExecutionNode;
    readonly result: AuthorizedAgentGraphToolResultDTO;
  }>,
): ExecutionNode {
  const firstParent = tools[0]?.node;
  return {
    id: crypto.randomUUID(),
    parentId: firstParent?.id ?? AGENT_CORE_ID,
    parentIds: tools.map((item) => item.node.id),
    label: "Verified observations",
    detail: `${tools.length} tool result${tools.length === 1 ? "" : "s"} collected. Continue from verified data.`,
    modelDetail: tools.map((item) => item.result.modelSummary).join(" "),
    kind: "observe",
    // Same reasoning as makeToolResultNode: merging results is not itself a
    // planning round. The round is charged when this node is expanded.
    depth: Math.max(...tools.map((item) => item.node.depth)),
    column: Math.max(...tools.map((item) => item.node.column)) + 1,
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

function makeBlockedNode(parent: ExecutionNode, detail: string): ExecutionNode {
  return {
    id: crypto.randomUUID(),
    parentId: parent.id,
    label: "Blocked",
    detail,
    kind: "blocked",
    depth: parent.depth + 1,
    column: parent.column + 1,
    expand: false,
    status: "blocked",
    startedAt: Date.now(),
  };
}

function compactLabel(goal: string): string {
  const words = goal.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, 5).join(" ") + (words.length > 5 ? "..." : "");
}
