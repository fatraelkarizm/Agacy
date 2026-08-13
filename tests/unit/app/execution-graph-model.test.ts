import { describe, expect, it } from "vitest";
import {
  formatBaseUnitAmount,
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

  it("restores completed nodes but marks interrupted work as blocked", () => {
    const nodes: ExecutionNode[] = [
      { id: "done", parentId: "agent-core", label: "Done", detail: "", kind: "result", depth: 0, column: 1, expand: false, status: "done" },
      { id: "live", parentId: "done", label: "Live", detail: "", kind: "tool", depth: 1, column: 2, expand: false, status: "running" },
    ];

    expect(restoreGraphNodes(nodes).map((node) => node.status)).toEqual(["done", "blocked"]);
  });
});
