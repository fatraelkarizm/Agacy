import { describe, expect, it } from "vitest";
import type { AuthorizedAgentRunEventDTO } from "../../../server/dto/agent-run.dto";
import {
  createAgentRunGoalEvent,
  toPublicAgentRunEvent,
} from "../../../server/services/agent-run";

describe("agent run graph privacy boundary", () => {
  it("keeps the queued owner goal out of its public pair", () => {
    const event = createAgentRunGoalEvent("Pay the private infrastructure invoice.");

    expect(event.authorized.detail).toContain("infrastructure");
    expect(event.public).toEqual({
      id: "goal",
      taskIndex: -1,
      kind: "goal",
      status: "queued",
    });
  });

  it("removes owner goal, amount, recipient, and reasoning from public events", () => {
    const authorized: AuthorizedAgentRunEventDTO = {
      id: "0-decide",
      taskIndex: 0,
      kind: "decide",
      status: "completed",
      taskLabel: "API subscription",
      detail: "Renew because private usage crossed the threshold.",
      amount: 4_200_000n,
      recipient: "Vendor111111111111111111111111111111111111",
    };

    expect(toPublicAgentRunEvent(authorized)).toEqual({
      id: "0-decide",
      taskIndex: 0,
      kind: "decide",
      status: "completed",
    });
  });

  it("keeps a confirmed signature public without adding private fields", () => {
    const authorized: AuthorizedAgentRunEventDTO = {
      id: "0-execute",
      taskIndex: 0,
      kind: "execute",
      status: "confirmed",
      detail: "Confirmed on devnet.",
      signature: "DevnetSignature",
      amount: 4_200_000n,
    };

    expect(toPublicAgentRunEvent(authorized)).toEqual({
      id: "0-execute",
      taskIndex: 0,
      kind: "execute",
      status: "confirmed",
      signature: "DevnetSignature",
    });
  });
});
