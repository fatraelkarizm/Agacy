import { describe, expect, it } from "vitest";
import { buildToolkit } from "@agent/tools/toolkit";
import { GRAPH_EXCLUDED_TOOLKIT_TOOLS, GRAPH_ONLY_TOOLS } from "@services/agent-graph";
import { agentGraphToolNameSchema } from "../../../server/schema/agent-graph.schema";

/**
 * The Agent Graph and the CLI toolkit are separate runtimes that happen to
 * share tool names. That split is deliberate — the graph needs tree-shaped
 * output and runs against a browser session key, so it cannot reuse the CLI's
 * execution path — but it means a tool added to the toolkit can silently never
 * reach the graph. That already happened once: get_token_price and
 * get_swap_quote existed in the toolkit for weeks while the graph dead-ended
 * every "buy me token X" goal into an unexplained blocked node.
 *
 * These tests make that failure loud. Adding a toolkit tool now forces an
 * explicit decision: expose it in the graph, or record why not.
 */

const graphToolNames = new Set<string>(agentGraphToolNameSchema.options);
const toolkitToolNames = new Set(buildToolkit().map((tool) => tool.name));

describe("agent graph / toolkit coverage", () => {
  it("routes every toolkit tool to either the graph or a recorded exclusion", () => {
    const undecided = [...toolkitToolNames].filter(
      (name) => !graphToolNames.has(name) && !(name in GRAPH_EXCLUDED_TOOLKIT_TOOLS),
    );

    expect(
      undecided,
      `These toolkit tools reach neither the Agent Graph nor GRAPH_EXCLUDED_TOOLKIT_TOOLS. ` +
        `Either expose them in the graph or record why they stay CLI-only: ${undecided.join(", ")}`,
    ).toEqual([]);
  });

  it("backs every graph tool with a real toolkit tool or a declared graph-only reason", () => {
    const unbacked = [...graphToolNames].filter(
      (name) => !toolkitToolNames.has(name) && !(name in GRAPH_ONLY_TOOLS),
    );

    expect(
      unbacked,
      `These graph tools exist in neither the toolkit nor GRAPH_ONLY_TOOLS: ${unbacked.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the exclusion lists free of names that no longer exist", () => {
    const staleExclusions = Object.keys(GRAPH_EXCLUDED_TOOLKIT_TOOLS).filter(
      (name) => !toolkitToolNames.has(name),
    );
    const staleGraphOnly = Object.keys(GRAPH_ONLY_TOOLS).filter(
      (name) => !graphToolNames.has(name),
    );

    expect(staleExclusions).toEqual([]);
    expect(staleGraphOnly).toEqual([]);
  });

  it("never excludes a tool without giving a reason", () => {
    for (const [name, reason] of Object.entries(GRAPH_EXCLUDED_TOOLKIT_TOOLS)) {
      expect(reason.length, `${name} needs a real reason, not an empty string`).toBeGreaterThan(20);
    }
    for (const [name, reason] of Object.entries(GRAPH_ONLY_TOOLS)) {
      expect(reason.length, `${name} needs a real reason, not an empty string`).toBeGreaterThan(20);
    }
  });
});
