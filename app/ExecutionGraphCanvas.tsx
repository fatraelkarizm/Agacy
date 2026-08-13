"use client";

import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Brain,
  CheckCircle,
  Eye,
  PlayCircle,
  Prohibit,
  Robot,
  ShieldCheck,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import {
  AGENT_CORE_ID,
  GRAPH_LEGEND,
  NODE_HEIGHT,
  NODE_KIND_META,
  NODE_WIDTH,
  focusedNodeIds,
  formatDuration,
  toolProvider,
  layoutExecutionGraph,
  type ExecutionNode,
  type ExecutionNodeKind,
} from "./execution-graph-model";

const KIND_ICON: Record<ExecutionNodeKind, Icon> = {
  agent: Robot,
  goal: PlayCircle,
  reason: Brain,
  observe: Eye,
  tool: Wrench,
  policy: ShieldCheck,
  result: CheckCircle,
  complete: CheckCircle,
  blocked: Prohibit,
};

type ExecutionNodeData = {
  readonly node: ExecutionNode;
  readonly isSelected: boolean;
  readonly isDimmed: boolean;
};

type ExecutionFlowNode = Node<ExecutionNodeData, "execution">;

/**
 * One card in the graph. Everything the viewer needs to read the run without
 * opening the detail panel — what kind of step it is, what it did, whether it
 * finished, and how long it took — is on the card itself. The old canvas hid
 * all of this behind a hover state on a 6px dot.
 */
function ExecutionNodeCard({ data }: NodeProps<ExecutionFlowNode>) {
  const { node, isSelected, isDimmed } = data;
  const meta = NODE_KIND_META[node.kind];
  const NodeIcon = KIND_ICON[node.kind];
  const duration = formatDuration(node);
  const provider = toolProvider(node);

  return (
    <div
      className={[
        "xnode",
        `xnode-${meta.tone}`,
        `xnode-status-${node.status}`,
        isSelected ? "is-selected" : "",
        isDimmed ? "is-dimmed" : "",
      ].join(" ")}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="xnode-icon">
        <NodeIcon aria-hidden="true" size={17} weight="duotone" />
      </span>
      <span className="xnode-body">
        <span className="xnode-label">{node.label}</span>
        <span className="xnode-meta">
          {provider && (
            <span className="xnode-provider" title={`${provider.gateway} → ${provider.upstream}`}>
              {/* Plain <img>, not next/image: these are tiny static marks inside a
                  React Flow node, and the optimiser's wrapper breaks the layout. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={provider.gatewayLogo} alt="" width={11} height={11} />
              {provider.gateway}
              <span className="xnode-provider-sep">›</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={provider.upstreamLogo} alt="" width={11} height={11} />
              {provider.upstream}
            </span>
          )}
          <span className="xnode-kind">{node.toolCall?.name ?? meta.label}</span>
          {duration && <span className="xnode-duration">{duration}</span>}
        </span>
      </span>
      <span className={`xnode-status xnode-status-dot-${node.status}`} aria-hidden="true" />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { execution: ExecutionNodeCard };

interface ExecutionGraphCanvasProps {
  readonly nodes: readonly ExecutionNode[];
  readonly selectedId: string;
  readonly running: boolean;
  readonly followActive: boolean;
  readonly focusMode: boolean;
  readonly onSelect: (id: string) => void;
  readonly onRequestGoal: () => void;
}

function CanvasInner({
  nodes,
  selectedId,
  running,
  followActive,
  focusMode,
  onSelect,
  onRequestGoal,
}: ExecutionGraphCanvasProps) {
  const { fitView, getNode, setCenter } = useReactFlow();
  /*
    React Flow already keeps the measured canvas size in its own store and
    updates it from an internal resize observer. Reading it here rather than
    adding a second observer means the centring effect below re-runs whenever
    the canvas is remeasured — which is the actual fix for the parked viewport:
    opening the detail panel changes the grid columns and mounting the stats and
    log changes the height, so a centre computed before that settled was aiming
    at dimensions the canvas no longer had, and left the graph scrolled off the
    content with one card jammed against an edge.
  */
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);

  const coreNode = useMemo<ExecutionNode>(
    () => ({
      id: AGENT_CORE_ID,
      parentId: "",
      label: "AI Agent",
      detail: "The owner's agent. Every goal in this run starts here.",
      kind: "agent",
      depth: 0,
      column: 0,
      expand: false,
      status: running ? "running" : "done",
    }),
    [running],
  );

  // Null outside focus mode, so the ordinary view never dims anything.
  const litNodeIds = useMemo(
    () => (focusMode ? focusedNodeIds(nodes, selectedId) : null),
    [focusMode, nodes, selectedId],
  );

  const flowNodes = useMemo<ExecutionFlowNode[]>(() => {
    const positions = layoutExecutionGraph(nodes);
    return [coreNode, ...nodes].map((node) => ({
      id: node.id,
      type: "execution" as const,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        node,
        isSelected: node.id === selectedId,
        isDimmed: litNodeIds !== null && !litNodeIds.has(node.id),
      },
      draggable: false,
      connectable: false,
      selectable: true,
    }));
  }, [coreNode, litNodeIds, nodes, selectedId]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      nodes.flatMap((node) =>
        (node.parentIds ?? [node.parentId]).map((parentId) => {
          // An edge stays lit only when both of its ends are, so a bright edge
          // can never trail off into a card the viewer cannot see.
          const dimmed =
            litNodeIds !== null && (!litNodeIds.has(parentId) || !litNodeIds.has(node.id));
          return {
            id: `${parentId}->${node.id}`,
            source: parentId,
            target: node.id,
            type: "smoothstep",
            animated: node.status === "running",
            className: `xedge xedge-${node.status}${dimmed ? " xedge-dimmed" : ""}`,
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          };
        }),
      ),
    [litNodeIds, nodes],
  );

  /**
   * Keeps the newest work on screen while a run is growing. Skipped once the
   * viewer turns Follow off so their own pan and zoom is never yanked away.
   *
   * This pans to the active node at a fixed zoom rather than re-fitting the
   * whole graph. Fitting looks right for the first handful of nodes and then
   * degrades badly: a 20-node run has to shrink far enough that the card text
   * stops being readable, which is the same failure the old dot canvas had.
   * The viewer can still see everything at once through the Controls' own fit
   * button — it just is not forced on them every time a node arrives.
   */
  useEffect(() => {
    // Focus mode always recentres on the selection, whether or not Follow is
    // on: choosing a node *is* the request to look at it.
    if (!followActive && !focusMode) return;
    // Never aim at an unmeasured canvas — that is what produced a viewport
    // parked over empty space.
    if (canvasWidth === 0 || canvasHeight === 0) return;

    const timer = setTimeout(() => {
      const target = getNode(selectedId);
      if (target) {
        void setCenter(
          target.position.x + NODE_WIDTH / 2,
          target.position.y + NODE_HEIGHT / 2,
          { zoom: focusMode ? 1.15 : 0.85, duration: 420 },
        );
      } else {
        void fitView({ duration: 420, padding: 0.22, maxZoom: 1 });
      }
    }, 90);
    return () => clearTimeout(timer);
  }, [
    canvasHeight,
    canvasWidth,
    fitView,
    flowNodes.length,
    focusMode,
    followActive,
    getNode,
    selectedId,
    setCenter,
  ]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneContextMenu={(event) => {
        event.preventDefault();
        onRequestGoal();
      }}
      nodesDraggable={false}
      nodesConnectable={false}
      panOnScroll
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      fitView
      fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(144,126,246,0.18)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

export function ExecutionGraphCanvas(props: ExecutionGraphCanvasProps) {
  return (
    <div className={`xgraph-canvas-shell${props.focusMode ? " is-focus" : ""}`}>
      <div className="xgraph-canvas">
        <ReactFlowProvider>
          <CanvasInner {...props} />
        </ReactFlowProvider>
        {props.focusMode && (
          <p className="xgraph-focus-hint">
            Focus mode · click any node to inspect it · Esc to exit
          </p>
        )}
      </div>
      {/*
        A strip below the canvas rather than an overlay inside it. As an
        overlay the legend sat on top of live nodes — an explanation of the
        data covering the data it explains.
      */}
      <ul className="xgraph-legend" aria-label="Node types">
        {GRAPH_LEGEND.map((entry) => (
          <li key={entry.tone}>
            <span className={`xgraph-legend-dot xgraph-legend-${entry.tone}`} aria-hidden="true" />
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
