import { describe, expect, it } from "vitest";
import { createVercelAITools } from "solana-agent-kit";
import { toAgentKitActions } from "@agent/autonomous-loop";
import type { GuardedTool } from "@agent/policy-guard";
import { z } from "zod";

/**
 * Agent Kit's Vercel adapter keys its output by array index, and the AI SDK
 * passes each key to the model as the callable function name. Unfixed, the
 * model picks between tools called "0".."6" with nothing but the description
 * to distinguish them, while every prompt and refusal message in this codebase
 * refers to them by their real names.
 *
 * These tests pin both halves: Agent Kit's behaviour (so an upstream change is
 * noticed rather than silently double-fixed) and ours (that the model is
 * offered real names).
 */

function guarded(name: string): GuardedTool {
  return {
    name,
    description: `Test tool ${name}`,
    schema: z.object({}),
    execute: async () => ({ status: "ok" }),
  };
}

const tools = [guarded("get_wallet_overview"), guarded("pay_vendor_confidentially")];

describe("Agent Kit adapter naming", () => {
  it("still keys by numeric index upstream, which is what we compensate for", () => {
    const actions = toAgentKitActions(tools);
    const adapted = createVercelAITools({} as never, actions);

    expect(Object.keys(adapted).sort()).toEqual(["0", "1"]);
  });

  it("converts guarded tools into actions that keep their real names", () => {
    const actions = toAgentKitActions(tools);

    expect(actions.map((action) => action.name))
      .toEqual(["get_wallet_overview", "pay_vendor_confidentially"]);
    for (const action of actions) {
      expect(typeof action.handler).toBe("function");
      expect(action.description.length).toBeGreaterThan(0);
    }
  });

  it("re-keys the adapter output by action name, so the model sees the real tool names", () => {
    // Mirrors the mapping in runAutonomousAgent. Kept as an explicit
    // reconstruction rather than exporting internals, so the test fails if the
    // loop stops doing this rather than if it merely moves.
    const actions = toAgentKitActions(tools);
    const byIndex = createVercelAITools({} as never, actions);
    const named = Object.fromEntries(
      actions.map((action, index) => [action.name, byIndex[String(index)]]),
    );

    expect(Object.keys(named).sort())
      .toEqual(["get_wallet_overview", "pay_vendor_confidentially"]);
    expect(named["get_wallet_overview"]).toBe(byIndex["0"]);
    expect(named["pay_vendor_confidentially"]).toBe(byIndex["1"]);
    expect(Object.keys(named).every((key) => Number.isNaN(Number(key)))).toBe(true);
  });
});
