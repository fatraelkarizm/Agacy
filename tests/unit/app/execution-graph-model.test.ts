import { describe, expect, it } from "vitest";
import {
  formatBaseUnitAmount,
  expandableGraphNodes,
  initialExecutionNodeStatus,
  paymentReceipt,
  restoreGraphNodes,
  type ExecutionNode,
} from "../../../app/execution-graph-model";
import type { AuthorizedAgentGraphToolResultDTO } from "@dto/agent-graph.dto";

describe("execution graph payment accounting", () => {
  it("keeps verified devnet accounting attached to the payment receipt", () => {
    const result: AuthorizedAgentGraphToolResultDTO = {
      tool: "pay_confidentially",
      status: "succeeded",
      summary: "The amount is NOT readable on-chain.",
      modelSummary: "A confidential payment completed.",
      signature: "devnet-signature",
      paymentAccounting: {
        asset: "demo token",
        tokenBalanceBefore: "50000000",
        amountSpent: "2000000",
        tokenBalanceAfter: "48000000",
        payerSolBeforeLamports: "2000000000",
        transactionFeeLamports: "5000",
        payerSolAfterLamports: "1999975000",
      },
    };

    expect(paymentReceipt({ toolResult: result })?.accounting).toEqual(result.paymentAccounting);
  });

  it("formats token and SOL base units without floating-point rounding", () => {
    expect(formatBaseUnitAmount("48000000", 6)).toBe("48");
    expect(formatBaseUnitAmount("1999975000", 9)).toBe("1.999975");
    expect(formatBaseUnitAmount("5000", 9)).toBe("0.000005");
  });

  it("restores completed nodes but marks interrupted and unstarted work as blocked", () => {
    const nodes: ExecutionNode[] = [
      { id: "done", parentId: "agent-core", label: "Done", detail: "", kind: "result", depth: 0, column: 1, expand: false, status: "done" },
      { id: "live", parentId: "done", label: "Live", detail: "", kind: "tool", depth: 1, column: 2, expand: false, status: "running" },
      { id: "queued", parentId: "done", label: "Queued", detail: "", kind: "reason", depth: 1, column: 2, expand: true, status: "queued" },
    ];

    expect(restoreGraphNodes(nodes).map((node) => node.status)).toEqual(["done", "blocked", "blocked"]);
  });

  it("keeps an expandable sibling scheduled after a tool call", () => {
    const nodes: ExecutionNode[] = [
      { id: "tool", parentId: "goal", label: "Read", detail: "", kind: "tool", depth: 1, column: 2, expand: false, status: "queued", toolCall: { name: "get_wallet_overview", input: {} } },
      { id: "report", parentId: "goal", label: "Report", detail: "", kind: "reason", depth: 1, column: 2, expand: true, status: "queued" },
    ];

    expect(expandableGraphNodes(nodes).map((node) => node.id)).toEqual(["report"]);
  });

  it("settles terminal nodes even if the model asked to expand them", () => {
    expect(initialExecutionNodeStatus("complete", false, false)).toBe("done");
    expect(initialExecutionNodeStatus("result", false, false)).toBe("done");
    expect(initialExecutionNodeStatus("observe", false, false)).toBe("done");
    expect(initialExecutionNodeStatus("blocked", false, false)).toBe("blocked");
  });
});
