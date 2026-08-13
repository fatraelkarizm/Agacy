import type {
  AgentGraphNodeKind,
  AgentGraphToolCallDTO,
  AgentGraphToolName,
  AuthorizedAgentGraphToolResultDTO,
} from "../server/dto/agent-graph.dto";

/**
 * Shared shape and layout for the Agent Graph canvas.
 *
 * The previous canvas placed every node on a polar coordinate around a centre
 * point and then clamped x/y into the viewport. Two nodes at a similar angle
 * landed on top of each other, and anything past the third level was clamped
 * flat against the canvas edge — a 84-node run put 56 of them in the outer 1%
 * of the canvas, which is why the result read as scattered dots rather than a
 * graph. Layout here is a layered tidy tree instead: depth decides the column,
 * and a node sits vertically centred on its own children, so an edge can never
 * be ambiguous about which parent it came from.
 */

export type ExecutionNodeKind = AgentGraphNodeKind | "goal" | "agent";
export type ExecutionNodeStatus = "queued" | "running" | "done" | "blocked";

export const AGENT_CORE_ID = "agent-core";

export type ExecutionNode = {
  readonly id: string;
  readonly parentId: string;
  /** Merge parents for observation nodes; the first is also `parentId`. */
  readonly parentIds?: readonly string[];
  readonly label: string;
  readonly detail: string;
  /** Redacted detail sent back to the model, when it differs from `detail`. */
  readonly modelDetail?: string;
  readonly kind: ExecutionNodeKind;
  /**
   * Planning budget, not layout. A tool result deliberately shares its tool
   * node's depth because it is bookkeeping for a round that already happened
   * rather than a new round of planning.
   */
  readonly depth: number;
  /** Layout column. Always one past the parent, unlike `depth`. */
  readonly column: number;
  readonly expand: boolean;
  readonly status: ExecutionNodeStatus;
  readonly toolCall?: AgentGraphToolCallDTO;
  readonly toolResult?: AuthorizedAgentGraphToolResultDTO;
  readonly startedAt?: number;
  readonly endedAt?: number;
};

/**
 * Where a tool's data actually came from.
 *
 * Two levels, because they answer different questions. `gateway` is who was
 * paid and who could see the request; `upstream` is who the figure originally
 * belongs to. Crediting only the gateway would imply AIsa priced the token, and
 * crediting only the upstream would hide that the call left through a sponsor's
 * infrastructure. A viewer deciding whether to trust a number needs both.
 */
export interface ToolProvider {
  readonly gateway: string;
  readonly gatewayLogo: string;
  readonly upstream: string;
  readonly upstreamLogo: string;
}

export const TOOL_PROVIDERS: Partial<Record<AgentGraphToolName, ToolProvider>> = {
  cross_check_token_price: {
    gateway: "AIsa",
    gatewayLogo: "/providers/aisa.svg",
    upstream: "CoinGecko",
    upstreamLogo: "/providers/coingecko.ico",
  },
  research_counterparty: {
    gateway: "AIsa",
    gatewayLogo: "/providers/aisa.svg",
    upstream: "Tavily",
    upstreamLogo: "/providers/tavily.ico",
  },
};

export function toolProvider(node: {
  readonly toolCall?: AgentGraphToolCallDTO;
  readonly toolResult?: AuthorizedAgentGraphToolResultDTO;
}): ToolProvider | null {
  const tool = node.toolCall?.name ?? node.toolResult?.tool;
  return tool === undefined ? null : TOOL_PROVIDERS[tool] ?? null;
}

/**
 * A payment receipt is not just another tool result. It is the only node in a
 * run where value actually moved, and it carries the signature that makes the
 * claim checkable — so it gets its own treatment rather than looking like a
 * price lookup that happened to come last.
 */
export function paymentReceipt(node: {
  readonly toolCall?: AgentGraphToolCallDTO;
  readonly toolResult?: AuthorizedAgentGraphToolResultDTO;
}): { readonly confidential: boolean; readonly signature: string } | null {
  const result = node.toolResult;
  if (result?.tool !== "pay_confidentially" || result.status !== "succeeded") return null;
  if (!result.signature) return null;
  // The summary is the only place the executed mode survives onto the node.
  return { confidential: !result.summary.includes("IS readable"), signature: result.signature };
}

export function isAisaPowered(node: {
  readonly toolCall?: AgentGraphToolCallDTO;
  readonly toolResult?: AuthorizedAgentGraphToolResultDTO;
}): boolean {
  return toolProvider(node)?.gateway === "AIsa";
}

export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 68;
const COLUMN_GAP = 78;
const ROW_GAP = 18;

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

export interface KindMeta {
  readonly label: string;
  /** Drives the card border, icon colour, and legend swatch. */
  readonly tone: "agent" | "goal" | "llm" | "observe" | "tool" | "policy" | "result" | "blocked";
}

export const NODE_KIND_META: Record<ExecutionNodeKind, KindMeta> = {
  agent: { label: "Agent", tone: "agent" },
  goal: { label: "Owner goal", tone: "goal" },
  reason: { label: "LLM step", tone: "llm" },
  observe: { label: "Observation", tone: "observe" },
  tool: { label: "Tool call", tone: "tool" },
  policy: { label: "Policy check", tone: "policy" },
  result: { label: "Result", tone: "result" },
  complete: { label: "Complete", tone: "result" },
  blocked: { label: "Refusal", tone: "blocked" },
};

export const GRAPH_LEGEND: ReadonlyArray<{ readonly tone: KindMeta["tone"]; readonly label: string }> = [
  { tone: "goal", label: "Owner goal" },
  { tone: "llm", label: "LLM step" },
  { tone: "tool", label: "Tool call" },
  { tone: "policy", label: "Policy check" },
  { tone: "observe", label: "Observation" },
  { tone: "result", label: "Result" },
  { tone: "blocked", label: "Refusal" },
];

/**
 * Reingold-Tilford first pass: leaves take the next free row, a parent centres
 * on the rows its children occupy. Children are visited in insertion order, so
 * a node that has already been placed never moves when a sibling arrives later
 * in the run — the graph grows rightward instead of reshuffling under the
 * viewer.
 */
export function layoutExecutionGraph(
  nodes: readonly ExecutionNode[],
): ReadonlyMap<string, NodePosition> {
  const childrenOf = new Map<string, ExecutionNode[]>();
  for (const node of nodes) {
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }

  const rows = new Map<string, number>();
  const visited = new Set<string>();
  let nextRow = 0;

  const assignRow = (id: string): number => {
    // Guards against a malformed parent chain rather than an expected cycle:
    // ids are uuids and a parent always exists before its child.
    if (visited.has(id)) return rows.get(id) ?? 0;
    visited.add(id);

    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) {
      const row = nextRow++;
      rows.set(id, row);
      return row;
    }

    const childRows = children.map((child) => assignRow(child.id));
    const row = (Math.min(...childRows) + Math.max(...childRows)) / 2;
    rows.set(id, row);
    return row;
  };

  assignRow(AGENT_CORE_ID);
  // Anything the walk from the core could not reach (a parent that was pruned)
  // still gets a row so it renders instead of silently vanishing.
  for (const node of nodes) if (!rows.has(node.id)) assignRow(node.id);

  const positions = new Map<string, NodePosition>();
  const place = (id: string, column: number) => {
    const row = rows.get(id) ?? 0;
    positions.set(id, {
      x: column * (NODE_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    });
  };

  place(AGENT_CORE_ID, 0);
  for (const node of nodes) place(node.id, node.column);
  return positions;
}

/**
 * What an unauthorized observer of the graph is allowed to read.
 *
 * A *closed* shape, deliberately mirroring `PublicTransactionDTO` in
 * server/dto/transaction.dto.ts: it carries no `detail`, no `toolCall.input`,
 * and no `toolResult` at all, so there is no owner-only field for a public
 * surface to render by accident.
 *
 * What it does keep — structure, kind, status, tool *name*, and timing — is
 * kept on purpose. docs/PRIVACY_ARCHITECTURE.md §4 and docs/JUDGE_PRIVACY_FLOW.md
 * both state plainly that timing, program interaction and fee payer stay
 * observable. Hiding them here would demo a privacy property this project does
 * not have, which is worse than showing the real boundary.
 */
export type PublicExecutionNode = {
  readonly id: string;
  readonly parentId: string;
  readonly parentIds?: readonly string[];
  readonly label: string;
  readonly kind: ExecutionNodeKind;
  readonly depth: number;
  readonly column: number;
  readonly status: ExecutionNodeStatus;
  /** The tool's name only. Its arguments are owner-only and never included. */
  readonly toolName?: AgentGraphToolName;
  /** Which step used sponsor infrastructure is not owner detail. */
  readonly aisaPowered: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
};

/**
 * The only sanctioned way to derive the public view of a graph node.
 *
 * Field-by-field construction, never spread-and-delete, for the same reason
 * `toPublicView` is written that way: adding a sensitive field to
 * `ExecutionNode` later must not silently appear in the public view. A leak
 * here should require deleting a line, not forgetting one.
 */
export function toPublicGraphNode(node: ExecutionNode): PublicExecutionNode {
  return {
    id: node.id,
    parentId: node.parentId,
    ...(node.parentIds ? { parentIds: node.parentIds } : {}),
    // Labels are the model's own short action names ("Get SOL price"), not
    // owner detail — they are already what goes back to the model as lineage.
    label: node.label,
    kind: node.kind,
    depth: node.depth,
    column: node.column,
    status: node.status,
    ...(node.toolCall ? { toolName: node.toolCall.name } : {}),
    aisaPowered: isAisaPowered(node),
    ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
    ...(node.endedAt === undefined ? {} : { endedAt: node.endedAt }),
  };
}

/** Stand-in text shown wherever the public view withholds owner detail. */
export const REDACTED_DETAIL = "Withheld. Owner view required to read this step.";

/**
 * The nodes focus mode keeps lit: the selected node, the thread of parents that
 * led to it, and the one level of children it opened up.
 *
 * Ancestors are included rather than the selected node alone because a single
 * lit card carries no information about *why* the agent got there — the reason
 * the graph exists at all. One level of children is included for the same
 * reason in the other direction: it shows what the step led to without pulling
 * the entire subtree back into view.
 *
 * Returns null when nothing is selected, which callers read as "dim nothing".
 */
export function focusedNodeIds(
  nodes: readonly ExecutionNode[],
  selectedId: string | null,
): ReadonlySet<string> | null {
  if (!selectedId) return null;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keep = new Set<string>([AGENT_CORE_ID, selectedId]);

  // Terminates because the loop stops the moment it reaches an id already in
  // `keep`, and every chain ends at the core, which is seeded above.
  let cursor = byId.get(selectedId);
  while (cursor && !keep.has(cursor.parentId)) {
    keep.add(cursor.parentId);
    cursor = byId.get(cursor.parentId);
  }

  // An observation node merges several tool results; all of them are the thread.
  for (const parentId of byId.get(selectedId)?.parentIds ?? []) keep.add(parentId);

  for (const node of nodes) {
    if ((node.parentIds ?? [node.parentId]).includes(selectedId)) keep.add(node.id);
  }
  return keep;
}

/** Takes the timing fields only, so the public and owner views can share it. */
export function formatDuration(node: {
  readonly startedAt?: number;
  readonly endedAt?: number;
}): string | null {
  if (node.startedAt === undefined || node.endedAt === undefined) return null;
  const seconds = (node.endedAt - node.startedAt) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * The one tool that moves value. Kept as a helper so the spend card and the
 * detail panel cannot disagree about what counts as an authorized spend.
 */
export function authorizedSpendTokens(nodes: readonly ExecutionNode[]): number {
  return nodes.reduce((total, node) => {
    if (node.toolCall?.name !== "authorize_policy_spend") return total;
    if (node.toolResult?.status !== "succeeded") return total;
    return total + node.toolCall.input.amountTokens;
  }, 0);
}
