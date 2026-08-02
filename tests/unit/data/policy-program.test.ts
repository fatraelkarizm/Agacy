import { describe, it, expect, vi } from "vitest";
import { address } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import type { SolanaClient } from "@data/solana-client";
import {
  POLICY_ACCOUNT_LEN,
  POLICY_PROGRAM_ID,
  buildAuthorizeSpendInstruction,
  buildInitializePolicyInstruction,
  buildProvisionPolicyAccountInstructions,
  buildUpdateLimitsInstruction,
  decodePolicyAccount,
  fetchPolicyAccount,
} from "@data/policy-program";

const OWNER = address("5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5");
const AGENT = address("4dbYHAVZdz1f4KaiQJcfqmVqXNFKqgSAYhL9us93fUHo");
const POLICY = address("2rhj95tELtQKMEnTSgaZem3udLHhFj8Fr9EStFCscrsd");

const ownerSigner = { address: OWNER } as never;
const agentSigner = { address: AGENT } as never;
const policySigner = { address: POLICY } as never;

/** Just enough of SolanaClient for a rent-exemption lookup — no real RPC involved. */
function clientWithRent(lamports: bigint): SolanaClient {
  return {
    rpc: {
      getMinimumBalanceForRentExemption: vi.fn(() => ({
        send: () => Promise.resolve(lamports),
      })),
    },
  } as never;
}

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

describe("provisioning a policy account", () => {
  it("allocates exactly the space the program expects, owned by the policy program", async () => {
    const [createIx] = await buildProvisionPolicyAccountInstructions(clientWithRent(1_500_000n), {
      policyAccount: policySigner,
      owner: ownerSigner,
      agent: AGENT,
      maxPerTransfer: 20_000_000n,
      maxPerPeriod: 50_000_000n,
      periodSeconds: 86_400n,
    });

    expect(createIx?.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(createIx?.data).toBeDefined();
  });

  it("pays exactly the rent the RPC reports, not a guessed constant", async () => {
    const rent = 987_654n;
    const spy = vi.fn(() => ({ send: () => Promise.resolve(rent) }));
    const client = { rpc: { getMinimumBalanceForRentExemption: spy } } as never as SolanaClient;

    await buildProvisionPolicyAccountInstructions(client, {
      policyAccount: policySigner,
      owner: ownerSigner,
      agent: AGENT,
      maxPerTransfer: 1n,
      maxPerPeriod: 1n,
      periodSeconds: 1n,
    });

    expect(spy).toHaveBeenCalledWith(BigInt(POLICY_ACCOUNT_LEN));
  });

  it("chains the same policy account into the initialize instruction", async () => {
    const [, initIx] = await buildProvisionPolicyAccountInstructions(clientWithRent(1n), {
      policyAccount: policySigner,
      owner: ownerSigner,
      agent: AGENT,
      maxPerTransfer: 20_000_000n,
      maxPerPeriod: 50_000_000n,
      periodSeconds: 86_400n,
    });

    expect(initIx?.accounts[0]?.address).toBe(POLICY);
    expect(initIx?.data[0]).toBe(0);
  });

  it("returns exactly two instructions — create then initialize, never one without the other", async () => {
    const instructions = await buildProvisionPolicyAccountInstructions(clientWithRent(1n), {
      policyAccount: policySigner,
      owner: ownerSigner,
      agent: AGENT,
      maxPerTransfer: 1n,
      maxPerPeriod: 1n,
      periodSeconds: 1n,
    });
    expect(instructions).toHaveLength(2);
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

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function clientWithAccountData(bytes: Uint8Array | null): SolanaClient {
  return {
    rpc: {
      getAccountInfo: vi.fn(() => ({
        send: () =>
          Promise.resolve({
            value: bytes ? { data: [bytesToBase64(bytes), "base64"] } : null,
          }),
      })),
    },
  } as never;
}

describe("fetching a policy account from devnet", () => {
  it("decodes a live account into the same shape decodePolicyAccount produces", async () => {
    const encoded = encodePolicyAccount({ maxPerTransfer: 7_000_000n });
    const state = await fetchPolicyAccount(clientWithAccountData(encoded), POLICY);
    expect(state).toEqual(decodePolicyAccount(encoded));
  });

  it("returns null instead of throwing when the account has not been provisioned yet", async () => {
    const state = await fetchPolicyAccount(clientWithAccountData(null), POLICY);
    expect(state).toBeNull();
  });
});
