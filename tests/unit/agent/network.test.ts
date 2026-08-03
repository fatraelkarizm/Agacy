import { describe, it, expect } from "vitest";
import { resolveNetwork, authorizeMainnetRun } from "@agent/network";

describe("resolveNetwork", () => {
  it("defaults to devnet with no env set at all", () => {
    const network = resolveNetwork({});
    expect(network.cluster).toBe("devnet");
    expect(network.usesRealFunds).toBe(false);
    expect(network.rpcUrl).toContain("devnet");
  });

  it("accepts case/whitespace variants of the mainnet opt-in", () => {
    for (const value of ["Mainnet", "MAINNET ", " mainnet"]) {
      expect(resolveNetwork({ AGACY_CLUSTER: value }).cluster).toBe("mainnet");
    }
  });

  it("treats anything that isn't actually 'mainnet' as devnet, including near-miss typos", () => {
    for (const value of ["main", "production", "mainnett", ""]) {
      expect(resolveNetwork({ AGACY_CLUSTER: value }).cluster).toBe("devnet");
    }
  });

  it("resolves to mainnet only on an exact opt-in", () => {
    const network = resolveNetwork({ AGACY_CLUSTER: "mainnet" });
    expect(network.cluster).toBe("mainnet");
    expect(network.usesRealFunds).toBe(true);
  });

  it("never reuses the devnet RPC var for mainnet", () => {
    const network = resolveNetwork({
      AGACY_CLUSTER: "mainnet",
      AGACY_RPC_URL: "https://devnet.example.com",
    });
    expect(network.rpcUrl).not.toBe("https://devnet.example.com");
  });

  it("uses AGACY_MAINNET_RPC_URL when opted into mainnet", () => {
    const network = resolveNetwork({
      AGACY_CLUSTER: "mainnet",
      AGACY_MAINNET_RPC_URL: "https://my-mainnet-rpc.example.com",
    });
    expect(network.rpcUrl).toBe("https://my-mainnet-rpc.example.com");
  });
});

describe("authorizeMainnetRun", () => {
  it("refuses by default with no confirmation set", () => {
    const auth = authorizeMainnetRun({});
    expect(auth.authorized).toBe(false);
    expect(auth.maxSpendSol).toBe(0);
  });

  it("refuses a confirmation phrase that's close but not exact", () => {
    const auth = authorizeMainnetRun({ AGACY_MAINNET_CONFIRM: "i understand this spends real money" });
    expect(auth.authorized).toBe(false);
  });

  it("refuses even with the exact confirmation if no spend ceiling is given", () => {
    const auth = authorizeMainnetRun({
      AGACY_MAINNET_CONFIRM: "i-understand-this-spends-real-money",
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toMatch(/ceiling/);
  });

  it("refuses a zero or negative spend ceiling", () => {
    for (const value of ["0", "-1", "not-a-number"]) {
      const auth = authorizeMainnetRun({
        AGACY_MAINNET_CONFIRM: "i-understand-this-spends-real-money",
        AGACY_MAINNET_MAX_SPEND_SOL: value,
      });
      expect(auth.authorized).toBe(false);
    }
  });

  it("authorizes only with both the exact confirmation and a positive ceiling", () => {
    const auth = authorizeMainnetRun({
      AGACY_MAINNET_CONFIRM: "i-understand-this-spends-real-money",
      AGACY_MAINNET_MAX_SPEND_SOL: "0.05",
    });
    expect(auth.authorized).toBe(true);
    expect(auth.maxSpendSol).toBe(0.05);
  });
});
