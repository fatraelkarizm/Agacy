import { describe, it, expect, vi } from "vitest";
import { buildToolkit, type ToolContext } from "@agent/tools/toolkit";
import { defaultPolicy } from "../../fixtures/transactions";

function findTool(name: string) {
  const tool = buildToolkit().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found in toolkit: ${name}`);
  return tool;
}

function contextFor(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cluster: "devnet",
    ownerAddress: "Owner1111111111111111111111111111111111111",
    policy: defaultPolicy,
    spentThisPeriod: 0n,
    availableBalance: 1_000_000_000n,
    solLamports: 1_000_000_000n,
    maxSpendSol: 0,
    effects: {
      payConfidentially: vi.fn().mockResolvedValue({ signature: "sig" }),
      requestDevnetAirdrop: vi.fn().mockResolvedValue({ signature: "sig" }),
      fetchTokenPrice: vi.fn().mockResolvedValue({ mint: "mint", priceUsd: 1 }),
      fetchSwapQuote: vi.fn().mockResolvedValue({ inAmount: "1", outAmount: "1", priceImpactPct: null }),
      executeSwap: vi.fn().mockResolvedValue({ signature: "sig" }),
    },
    ...overrides,
  };
}

describe("toolkit — pay_vendor_confidentially", () => {
  it("declares spend in payment-token base units (6 decimals)", () => {
    const tool = findTool("pay_vendor_confidentially");
    const amount = tool.spendAmount!({ amount: 4.2, recipient: "x".repeat(32), reasoning: "y" } as never);
    expect(amount).toBe(4_200_000n);
  });

  it("is unavailable on mainnet, without ever calling the payment effect", async () => {
    const tool = findTool("pay_vendor_confidentially");
    const context = contextFor({ cluster: "mainnet" });

    const result = await tool.execute(
      { amount: 1, recipient: "x".repeat(32), reasoning: "y" } as never,
      context,
    );

    expect(result).toMatchObject({ status: "unavailable" });
    expect(context.effects.payConfidentially).not.toHaveBeenCalled();
  });

  it("calls the payment effect on devnet with base-unit amount", async () => {
    const tool = findTool("pay_vendor_confidentially");
    const context = contextFor({ cluster: "devnet" });

    const result = await tool.execute(
      { amount: 2, recipient: "vendor".padEnd(32, "1"), reasoning: "invoice" } as never,
      context,
    );

    expect(context.effects.payConfidentially).toHaveBeenCalledWith({
      amount: 2_000_000n,
      recipient: "vendor".padEnd(32, "1"),
      reasoning: "invoice",
    });
    expect(result).toMatchObject({ status: "paid", confidential: true });
  });
});

describe("toolkit — request_devnet_airdrop", () => {
  it("is unavailable on mainnet", async () => {
    const tool = findTool("request_devnet_airdrop");
    const context = contextFor({ cluster: "mainnet" });

    const result = await tool.execute({ sol: 1 } as never, context);

    expect(result).toMatchObject({ status: "unavailable" });
    expect(context.effects.requestDevnetAirdrop).not.toHaveBeenCalled();
  });

  it("requests lamports on devnet", async () => {
    const tool = findTool("request_devnet_airdrop");
    const context = contextFor({ cluster: "devnet" });

    await tool.execute({ sol: 1.5 } as never, context);

    expect(context.effects.requestDevnetAirdrop).toHaveBeenCalledWith({ lamports: 1_500_000_000n });
  });
});

describe("toolkit — swap_tokens", () => {
  it("refuses on devnet rather than simulating — Jupiter has no devnet router", async () => {
    const tool = findTool("swap_tokens");
    const context = contextFor({ cluster: "devnet" });

    const result = await tool.execute(
      { inputMint: "a".repeat(32), outputMint: "b".repeat(32), sol: 0.01 } as never,
      context,
    );

    expect(result).toMatchObject({ status: "refused" });
    expect(context.effects.executeSwap).not.toHaveBeenCalled();
  });

  it("refuses on mainnet if the amount exceeds the run's SOL ceiling", async () => {
    const tool = findTool("swap_tokens");
    const context = contextFor({ cluster: "mainnet", maxSpendSol: 0.01, solLamports: 1_000_000_000n });

    const result = await tool.execute(
      { inputMint: "a".repeat(32), outputMint: "b".repeat(32), sol: 0.5 } as never,
      context,
    );

    expect(result).toMatchObject({ status: "refused" });
    expect(context.effects.executeSwap).not.toHaveBeenCalled();
  });

  it("refuses on mainnet if the wallet doesn't hold enough SOL", async () => {
    const tool = findTool("swap_tokens");
    const context = contextFor({ cluster: "mainnet", maxSpendSol: 10, solLamports: 100n });

    const result = await tool.execute(
      { inputMint: "a".repeat(32), outputMint: "b".repeat(32), sol: 1 } as never,
      context,
    );

    expect(result).toMatchObject({ status: "refused" });
    expect(context.effects.executeSwap).not.toHaveBeenCalled();
  });

  it("executes on mainnet when within both the ceiling and the wallet's balance", async () => {
    const tool = findTool("swap_tokens");
    const context = contextFor({ cluster: "mainnet", maxSpendSol: 1, solLamports: 2_000_000_000n });

    const result = await tool.execute(
      { inputMint: "a".repeat(32), outputMint: "b".repeat(32), sol: 0.5 } as never,
      context,
    );

    expect(context.effects.executeSwap).toHaveBeenCalledWith({
      inputMint: "a".repeat(32),
      outputMint: "b".repeat(32),
      amountLamports: 500_000_000n,
    });
    expect(result).toMatchObject({ status: "swapped", realFunds: true });
  });
});
