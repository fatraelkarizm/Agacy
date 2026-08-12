import { describe, expect, it } from "vitest";
import type { SolanaClient } from "../../../server/data/solana-client";
import { executeAgentGraphTool } from "../../../server/services/agent-graph-tools";

const client = {} as SolanaClient;
const ownerAddress = "5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5";

describe("agent graph tools", () => {
  it("keeps owner detail out of the observation returned to the model", async () => {
    const result = await executeAgentGraphTool({
      call: { name: "get_wallet_overview", input: {} },
      ownerGoal: "Inspect my wallet.",
      client,
      ownerAddress,
      policy: {
        maxPerTransfer: 20_000_000n,
        maxPerPeriod: 80_000_000n,
        allowedRecipients: [],
      },
      policyAccount: null,
      agentSigner: null,
      spentThisPeriod: 4_000_000n,
    });

    expect(result.status).toBe("succeeded");
    expect(result.summary).toContain(ownerAddress);
    expect(result.modelSummary).not.toContain(ownerAddress);
    expect(result.modelSummary).not.toContain("20");
  });

  it("blocks state-changing calls when the ephemeral session key is gone", async () => {
    const result = await executeAgentGraphTool({
      call: {
        name: "authorize_policy_spend",
        input: {
          amountTokens: 4.25,
          recipient: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK",
          reasoning: "Renew the subscription.",
        },
      },
      ownerGoal: "Pay 4.25 tokens to Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK.",
      client,
      ownerAddress,
      policy: {
        maxPerTransfer: 20_000_000n,
        maxPerPeriod: 80_000_000n,
        allowedRecipients: [],
      },
      policyAccount: "8D4NwsXn9oL82ViTyqzkz4oQUS6Uqp5HKPSnavHsvzRB",
      agentSigner: null,
      spentThisPeriod: 0n,
    });

    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/session signing key/i);
  });

  it("rejects payment parameters invented outside the owner mandate", async () => {
    const result = await executeAgentGraphTool({
      call: {
        name: "authorize_policy_spend",
        input: {
          amountTokens: 19,
          recipient: "Sub1er4kQmVnH8dGpXwYzR3tNc5bVfJ2sLmQ9pDhK",
          reasoning: "Model-generated payment.",
        },
      },
      ownerGoal: "Review whether my wallet is ready.",
      client,
      ownerAddress,
      policy: {
        maxPerTransfer: 20_000_000n,
        maxPerPeriod: 80_000_000n,
        allowedRecipients: [],
      },
      policyAccount: "8D4NwsXn9oL82ViTyqzkz4oQUS6Uqp5HKPSnavHsvzRB",
      agentSigner: null,
      spentThisPeriod: 0n,
    });

    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/owner mandate/i);
  });
});
