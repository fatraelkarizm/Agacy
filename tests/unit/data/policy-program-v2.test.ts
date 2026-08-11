import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { address, getAddressEncoder } from "@solana/kit";
import {
  POLICY_V2_ACCOUNT_LEN,
  POLICY_V2_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  buildAssumeCustodyInstruction,
  buildAuthorizeAndInvokeInstruction,
  buildAuthorizeConfidentialAndInvokeInstruction,
  buildAuthorizeSpendV2Instruction,
  buildCustodyMaintenanceInstruction,
  buildInitializeConfidentialPolicyV2Instruction,
  buildInitializePolicyV2Instruction,
  buildReleaseCustodyInstruction,
  buildUpdateLimitsV2Instruction,
  decodePolicyV2Account,
  derivePolicyAddress,
} from "@data/policy-program-v2";

const OWNER = address("5HYaEvHzKZfw1VhWo9zz6SxqWgy4f7XUBWZFnBamJQC5");
const AGENT = address("4dbYHAVZdz1f4KaiQJcfqmVqXNFKqgSAYhL9us93fUHo");
const POLICY = address("2rhj95tELtQKMEnTSgaZem3udLHhFj8Fr9EStFCscrsd");
const TOKEN_ACCOUNT = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const RESCUE = address("11111111111111111111111111111112");

const ownerSigner = { address: OWNER } as never;
const agentSigner = { address: AGENT } as never;
const addressEncoder = getAddressEncoder();

/**
 * The reason these hardcoded discriminators are safe to hardcode. Anchor
 * derives them from the Rust function names, so a rename on the program side
 * silently changes the wire format — this recomputes every one of them from
 * the same source of truth Anchor uses.
 */
function anchorDiscriminator(namespace: string, name: string): number[] {
  return [...createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8)];
}

describe("anchor discriminators", () => {
  const cases: ReadonlyArray<[string, Uint8Array]> = [
    ["initialize", buildInitializePolicyV2Instruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      agent: AGENT,
      maxPerTransfer: 1n,
      maxPerPeriod: 1n,
      periodSeconds: 1n,
    }).data],
    ["initialize_confidential", buildInitializeConfidentialPolicyV2Instruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      agent: AGENT,
      limitPubkey: new Uint8Array(32).fill(1),
      maxPerTransferCt: new Uint8Array(64).fill(2),
      maxPerPeriodCt: new Uint8Array(64).fill(3),
      periodSeconds: 1n,
    }).data],
    ["update_limits", buildUpdateLimitsV2Instruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      maxPerTransfer: 1n,
      maxPerPeriod: 1n,
    }).data],
    ["authorize", buildAuthorizeSpendV2Instruction({
      policyAccount: POLICY,
      agent: agentSigner,
      amount: 1n,
    }).data],
    ["authorize_and_invoke", buildAuthorizeAndInvokeInstruction({
      policyAccount: POLICY,
      agent: agentSigner,
      targetProgram: TOKEN_2022_PROGRAM_ID,
      amount: 1n,
      instructionData: new Uint8Array([3]),
      forwardedAccounts: [],
    }).data],
    ["assume_custody", buildAssumeCustodyInstruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      tokenAccount: TOKEN_ACCOUNT,
    }).data],
    ["release_custody", buildReleaseCustodyInstruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      tokenAccount: TOKEN_ACCOUNT,
      newAuthority: OWNER,
    }).data],
    ["custody_maintenance", buildCustodyMaintenanceInstruction({
      policyAccount: POLICY,
      agent: agentSigner,
      targetProgram: TOKEN_2022_PROGRAM_ID,
      instructionData: new Uint8Array([27, 8]),
      forwardedAccounts: [],
    }).data],
    ["authorize_confidential_and_invoke", buildAuthorizeConfidentialAndInvokeInstruction({
      policyAccount: POLICY,
      agent: agentSigner,
      targetProgram: TOKEN_2022_PROGRAM_ID,
      transferEqualityProof: OWNER,
      periodEqualityProof: AGENT,
      rangeProof: RESCUE,
      transferValidityProof: POLICY,
      instructionData: new Uint8Array([27, 7]),
      forwardedAccounts: [],
    }).data],
  ];

  for (const [name, data] of cases) {
    it(`prefixes ${name} with sha256("global:${name}")[0..8]`, () => {
      expect([...data.slice(0, 8)]).toEqual(anchorDiscriminator("global", name));
    });
  }
});

describe("initialize", () => {
  const ix = buildInitializePolicyV2Instruction({
    policyAccount: POLICY,
    owner: ownerSigner,
    agent: AGENT,
    maxPerTransfer: 20_000_000n,
    maxPerPeriod: 50_000_000n,
    periodSeconds: 86_400n,
  });

  it("targets the v2 program", () => {
    expect(ix.programAddress).toBe(POLICY_V2_PROGRAM_ID);
  });

  it("encodes the agent as a borsh pubkey argument, not an account", () => {
    expect([...ix.data.slice(8, 40)]).toEqual([...addressEncoder.encode(AGENT)]);
    expect(ix.accounts.some((account) => account.address === AGENT)).toBe(false);
  });

  it("encodes the limits little-endian after the agent", () => {
    const view = new DataView(ix.data.buffer);
    expect(view.getBigUint64(40, true)).toBe(20_000_000n);
    expect(view.getBigUint64(48, true)).toBe(50_000_000n);
    expect(view.getBigInt64(56, true)).toBe(86_400n);
  });

  it("makes the owner a writable signer, since Anchor's init charges them rent", () => {
    const owner = ix.accounts.find((account) => account.address === OWNER);
    expect(owner?.role).toBe(3);
  });
});

describe("initialize_confidential", () => {
  const limitPubkey = new Uint8Array(32).fill(1);
  const maxPerTransferCt = new Uint8Array(64).fill(2);
  const maxPerPeriodCt = new Uint8Array(64).fill(3);
  const ix = buildInitializeConfidentialPolicyV2Instruction({
    policyAccount: POLICY,
    owner: ownerSigner,
    agent: AGENT,
    limitPubkey,
    maxPerTransferCt,
    maxPerPeriodCt,
    periodSeconds: 86_400n,
  });

  it("contains ciphertexts and no plaintext limit arguments", () => {
    expect([...ix.data.slice(8, 40)]).toEqual([...addressEncoder.encode(AGENT)]);
    expect([...ix.data.slice(40, 72)]).toEqual([...limitPubkey]);
    expect([...ix.data.slice(72, 136)]).toEqual([...maxPerTransferCt]);
    expect([...ix.data.slice(136, 200)]).toEqual([...maxPerPeriodCt]);
    expect(new DataView(ix.data.buffer).getBigInt64(200, true)).toBe(86_400n);

    const plaintextLimit = new Uint8Array(8);
    new DataView(plaintextLimit.buffer).setBigUint64(0, 20_000_000n, true);
    expect(Buffer.from(ix.data).includes(Buffer.from(plaintextLimit))).toBe(false);
  });

  it("rejects malformed ciphertexts before a transaction is built", () => {
    expect(() => buildInitializeConfidentialPolicyV2Instruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      agent: AGENT,
      limitPubkey,
      maxPerTransferCt: new Uint8Array(63),
      maxPerPeriodCt,
      periodSeconds: 86_400n,
    })).toThrow(/maxPerTransferCt must be 64 bytes/);
  });
});

describe("policy address derivation", () => {
  it("is deterministic for an owner/agent pair", async () => {
    const first = await derivePolicyAddress(OWNER, AGENT);
    const second = await derivePolicyAddress(OWNER, AGENT);
    expect(first).toBe(second);
  });

  it("gives different agents different policy accounts under one owner", async () => {
    const a = await derivePolicyAddress(OWNER, AGENT);
    const b = await derivePolicyAddress(OWNER, POLICY);
    expect(a).not.toBe(b);
  });

  it("is not symmetric — owner and agent are distinct roles in the seeds", async () => {
    expect(await derivePolicyAddress(OWNER, AGENT)).not.toBe(
      await derivePolicyAddress(AGENT, OWNER),
    );
  });
});

describe("custody instructions", () => {
  it("assume_custody carries no arguments beyond its discriminator", () => {
    const ix = buildAssumeCustodyInstruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      tokenAccount: TOKEN_ACCOUNT,
    });
    expect(ix.data.length).toBe(8);
  });

  it("assume_custody defaults to Token-2022, the program custody exists for", () => {
    const ix = buildAssumeCustodyInstruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      tokenAccount: TOKEN_ACCOUNT,
    });
    expect(ix.accounts[3]?.address).toBe(TOKEN_2022_PROGRAM_ID);
  });

  it("release_custody encodes the chosen new authority", () => {
    const ix = buildReleaseCustodyInstruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      tokenAccount: TOKEN_ACCOUNT,
      newAuthority: RESCUE,
    });
    expect([...ix.data.slice(8, 40)]).toEqual([...addressEncoder.encode(RESCUE)]);
  });

  it("requires the owner to sign both directions of custody", () => {
    const assume = buildAssumeCustodyInstruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      tokenAccount: TOKEN_ACCOUNT,
    });
    const release = buildReleaseCustodyInstruction({
      policyAccount: POLICY,
      owner: ownerSigner,
      tokenAccount: TOKEN_ACCOUNT,
      newAuthority: OWNER,
    });
    for (const ix of [assume, release]) {
      expect(ix.accounts.find((account) => account.address === OWNER)?.role).toBe(2);
    }
  });
});

describe("authorize_and_invoke", () => {
  const ix = buildAuthorizeAndInvokeInstruction({
    policyAccount: POLICY,
    agent: agentSigner,
    targetProgram: TOKEN_2022_PROGRAM_ID,
    amount: 5_000_000n,
    instructionData: new Uint8Array([3, 1, 2, 3]),
    forwardedAccounts: [
      { address: TOKEN_ACCOUNT, role: 1 },
      { address: POLICY, role: 0 },
    ],
  });

  it("borsh-encodes the forwarded instruction with a u32 length prefix", () => {
    const view = new DataView(ix.data.buffer);
    expect(view.getBigUint64(8, true)).toBe(5_000_000n);
    expect(view.getUint32(16, true)).toBe(4);
    expect([...ix.data.slice(20)]).toEqual([3, 1, 2, 3]);
  });

  it("appends forwarded accounts after the three named ones", () => {
    expect(ix.accounts.length).toBe(5);
    expect(ix.accounts[3]?.address).toBe(TOKEN_ACCOUNT);
  });

  it("puts the source account first, which is what the program checks against custody", () => {
    expect(ix.accounts[3]?.address).toBe(TOKEN_ACCOUNT);
  });
});

describe("authorize_confidential_and_invoke", () => {
  const ix = buildAuthorizeConfidentialAndInvokeInstruction({
    policyAccount: POLICY,
    agent: agentSigner,
    targetProgram: TOKEN_2022_PROGRAM_ID,
    transferEqualityProof: OWNER,
    periodEqualityProof: AGENT,
    rangeProof: RESCUE,
    transferValidityProof: POLICY,
    instructionData: new Uint8Array([27, 7, 0, 0]),
    forwardedAccounts: [{ address: TOKEN_ACCOUNT, role: 1 }],
  });

  it("accepts no caller-supplied amount claim", () => {
    const view = new DataView(ix.data.buffer);
    expect(view.getUint32(8, true)).toBe(4);
    expect([...ix.data.slice(12)]).toEqual([27, 7, 0, 0]);
  });

  it("passes the validity proof separately before forwarded Token-2022 accounts", () => {
    expect(ix.accounts[6]?.address).toBe(POLICY);
    expect(ix.accounts[7]?.address).toBe(TOKEN_ACCOUNT);
  });
});

describe("custody_maintenance", () => {
  const ix = buildCustodyMaintenanceInstruction({
    policyAccount: POLICY,
    agent: agentSigner,
    targetProgram: TOKEN_2022_PROGRAM_ID,
    instructionData: new Uint8Array([27, 8]),
    forwardedAccounts: [{ address: TOKEN_ACCOUNT, role: 1 }],
  });

  it("takes no amount — it must never consume spend budget", () => {
    const view = new DataView(ix.data.buffer);
    expect(view.getUint32(8, true)).toBe(2);
    expect([...ix.data.slice(12)]).toEqual([27, 8]);
  });

  it("leaves the policy account read-only, since nothing about it changes", () => {
    expect(ix.accounts[0]?.role).toBe(0);
  });
});

/** Build a policy account exactly as the on-chain program would write it. */
function encodePolicyV2Account(custodied?: string): Uint8Array {
  const data = new Uint8Array(POLICY_V2_ACCOUNT_LEN);
  const view = new DataView(data.buffer);
  data.set([222, 135, 7, 163, 235, 177, 33, 68], 0);
  data.set(addressEncoder.encode(OWNER), 8);
  data.set(addressEncoder.encode(AGENT), 40);
  view.setBigUint64(72, 20_000_000n, true);
  view.setBigUint64(80, 50_000_000n, true);
  view.setBigInt64(88, 86_400n, true);
  view.setBigUint64(96, 5_000_000n, true);
  view.setBigInt64(104, 1_754_000_000n, true);
  data[112] = 254;
  if (custodied) data.set(addressEncoder.encode(address(custodied)), 113);
  return data;
}

describe("decoding a policy account", () => {
  it("reads every field back at the offsets the program writes them", () => {
    const decoded = decodePolicyV2Account(encodePolicyV2Account());
    expect(decoded).toMatchObject({
      owner: OWNER,
      agent: AGENT,
      maxPerTransfer: 20_000_000n,
      maxPerPeriod: 50_000_000n,
      periodSeconds: 86_400n,
      spentInPeriod: 5_000_000n,
      periodStart: 1_754_000_000n,
      bump: 254,
    });
  });

  it("reports no custody as null rather than the program's zero-pubkey sentinel", () => {
    expect(decodePolicyV2Account(encodePolicyV2Account()).custodiedTokenAccount).toBeNull();
  });

  it("reports a real custodied account", () => {
    const decoded = decodePolicyV2Account(encodePolicyV2Account(TOKEN_ACCOUNT));
    expect(decoded.custodiedTokenAccount).toBe(TOKEN_ACCOUNT);
  });

  it("refuses an account written by a different program", () => {
    const data = encodePolicyV2Account();
    data[0] = 0;
    expect(() => decodePolicyV2Account(data)).toThrow(/not an agacy_policy_v2/);
  });

  it("refuses an account from the pre-custody layout instead of misreading it", () => {
    const short = encodePolicyV2Account().slice(0, 113);
    expect(() => decodePolicyV2Account(short)).toThrow(/too small/);
  });
});
