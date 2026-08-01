import { describe, it, expect } from "vitest";
import { toPublicView } from "@dto/transaction.dto";
import { authorizedTx } from "../../fixtures/transactions";

describe("public/authorized DTO boundary", () => {
  const sensitiveFields = ["amount", "counterparty", "resultingBalance", "agentReasoning"];

  it("strips every sensitive field from the public view", () => {
    const publicView = toPublicView(authorizedTx);
    for (const field of sensitiveFields) {
      expect(publicView).not.toHaveProperty(field);
    }
  });

  it("keeps only the fields a public observer is allowed to see", () => {
    const publicView = toPublicView(authorizedTx);
    expect(Object.keys(publicView).sort()).toEqual(
      ["confidential", "signature", "status", "timestamp"],
    );
  });

  it("preserves the non-sensitive fields verbatim", () => {
    const publicView = toPublicView(authorizedTx);
    expect(publicView.signature).toBe(authorizedTx.signature);
    expect(publicView.timestamp).toBe(authorizedTx.timestamp);
    expect(publicView.status).toBe(authorizedTx.status);
    expect(publicView.confidential).toBe(true);
  });

  it("does not leak sensitive values when serialized", () => {
    // The public DTO crosses the network as JSON — assert nothing sensitive
    // survives serialization, including via prototype or hidden keys.
    const serialized = JSON.stringify(toPublicView(authorizedTx));
    expect(serialized).not.toContain(String(authorizedTx.amount));
    expect(serialized).not.toContain(authorizedTx.counterparty);
    expect(serialized).not.toContain(String(authorizedTx.resultingBalance));
    expect(serialized).not.toContain(authorizedTx.agentReasoning);
  });
});
