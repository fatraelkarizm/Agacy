import { describe, it, expect } from "vitest";
import { address } from "@solana/kit";
import {
  POLICY_ACCOUNT_LEN,
  POLICY_PROGRAM_ID,
  buildAuthorizeSpendInstruction,
  buildInitializePolicyInstruction,
  buildUpdateLimitsInstruction,
  decodePolicyAccount,
} from "@data/policy-program";

const OWNER = address("5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5");
const AGENT = address("4dbYHAVZdz1f4KaiQJcfqmVqXNFKqgSAYhL9us93fUHo");
const POLICY = address("2rhj95tELtQKMEnTSgaZem3udLHhFj8Fr9EStFCscrsd");

const ownerSigner = { address: OWNER } as never;
const agentSigner = { address: AGENT } as never;

/** Build a policy account exactly as the on-chain program would write it. */
function encodePolicyAccount(overrides: Partial<Record<string, bigint>> = {}): Uint8Array {
  const data = new Uint8Array(POLICY_ACCOUNT_LEN);
  const view = new DataView(data.buffer);
  data[0] = 0xa6;
  view.setBigUint64(65, overrides["maxPerTransfer"] ?? 20_000_000n, true);
  view.setBigUint64(73, overrides["maxPerPeriod"] ?? 50_000_000n, true);
  view.setBigInt64(81, overrides["periodSeconds"] ?? 86_400n, true);
  view.setBigUint64(89, overrides["spentInPeriod"] ?? 5_000_000n, true);
  view.setBigInt64(97, overrides["periodStart"] ?? 1_754_000_000n, true);
  return data;
}

describe("initialize policy instruction", () => {
  const ix = buildInitializePolicyInstruction({
    policyAccount: POLICY,
    owner: ownerSigner,
    agent: AGENT,
    maxPerTransfer: 20_000_000n,
    maxPerPeriod: 50_000_000n,
    periodSeconds: 86_400n,
  });

  it("targets the deployed policy program", () => {
    expect(ix.programAddress).toBe(POLICY_PROGRAM_ID);
  });

  it("uses tag 0 and encodes limits little-endian", () => {
    const view = new DataView(ix.data.buffer);
    expect(ix.data[0]).toBe(0);
    expect(view.getBigUint64(33, true)).toBe(20_000_000n);
    expect(view.getBigUint64(41, true)).toBe(50_000_000n);
    expect(view.getBigInt64(49, true)).toBe(86_400n);
  });

  it("requires the owner as a signer", () => {
    expect(ix.accounts[1]?.address).toBe(OWNER);
    expect(ix.accounts[1]?.signer).toBeDefined();
  });
});

describe("authorize spend instruction", () => {
  const ix = buildAuthorizeSpendInstruction({
    policyAccount: POLICY,
    agent: agentSigner,
    amount: 4_200_000n,
  });

  it("uses tag 1 and carries the amount", () => {
    expect(ix.data[0]).toBe(1);
    expect(new DataView(ix.data.buffer).getBigUint64(1, true)).toBe(4_200_000n);
  });

  it("requires the agent to sign, not the owner", () => {
    // The agent spends; the owner sets limits. Conflating the two would let an
    // agent raise its own ceiling.
    expect(ix.accounts[1]?.address).toBe(AGENT);
    expect(ix.accounts[1]?.address).not.toBe(OWNER);
  });
});

describe("update limits instruction", () => {
  const ix = buildUpdateLimitsInstruction({
    policyAccount: POLICY,
    owner: ownerSigner,
    maxPerTransfer: 1_000n,
    maxPerPeriod: 2_000n,
  });

  it("uses tag 2 and encodes both limits", () => {
    const view = new DataView(ix.data.buffer);
    expect(ix.data[0]).toBe(2);
    expect(view.getBigUint64(1, true)).toBe(1_000n);
    expect(view.getBigUint64(9, true)).toBe(2_000n);
  });

  it("requires the owner, so an agent cannot raise its own limits", () => {
    expect(ix.accounts[1]?.address).toBe(OWNER);
  });
});

describe("policy account decoding", () => {
  it("reads every numeric field back correctly", () => {
    const state = decodePolicyAccount(encodePolicyAccount());
    expect(state.maxPerTransfer).toBe(20_000_000n);
    expect(state.maxPerPeriod).toBe(50_000_000n);
    expect(state.periodSeconds).toBe(86_400n);
    expect(state.spentInPeriod).toBe(5_000_000n);
    expect(state.periodStart).toBe(1_754_000_000n);
  });

  it("rejects an account that is not an initialized policy", () => {
    const data = encodePolicyAccount();
    data[0] = 0;
    expect(() => decodePolicyAccount(data)).toThrow(/not an initialized/);
  });

  it("rejects an undersized account rather than reading past the end", () => {
    expect(() => decodePolicyAccount(new Uint8Array(10))).toThrow(/too small/);
  });

  it("agrees with the length the program allocates", () => {
    // If this drifts, the client and program disagree about the layout.
    expect(POLICY_ACCOUNT_LEN).toBe(105);
  });
});
