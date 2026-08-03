import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import type { SolanaClient } from "./solana-client.js";

/**
 * Client for `agacy_policy_v2` — the PDA-based policy program.
 *
 * Differs from policy-program.ts (the original native program) in three ways
 * that matter to callers:
 *
 * 1. The policy account is a PDA derived from `[b"policy", owner, agent]`, not
 *    a generated keypair. Nothing has to be created and funded separately, and
 *    the same owner/agent pair always resolves to the same account — which is
 *    what lets the program sign for it, and therefore what makes the limit
 *    binding rather than advisory.
 * 2. It is an Anchor program, so instructions and accounts carry 8-byte
 *    discriminators and Borsh-encoded arguments rather than a single tag byte.
 * 3. It supports custody: `assume_custody` hands a token account's ownership
 *    to the policy PDA, and `release_custody` — owner-only, unconditional —
 *    hands it back.
 *
 * The byte layout is written out explicitly here rather than generated from an
 * IDL, matching policy-program.ts: a change on the program side that this file
 * does not expect fails loudly at the boundary instead of silently misreading
 * a field.
 */

export const POLICY_V2_PROGRAM_ID = address("9sYKkYh1GTKY2whkGPGXuG1VKiYqfiwyjVcpQbYtHtwW");

/** `b"policy"` — must match programs/agacy_policy_v2/src/constants.rs. */
export const POLICY_SEED = new TextEncoder().encode("policy");

export const SPL_TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");

/**
 * Anchor discriminators: the first 8 bytes of `sha256("global:<fn_name>")` for
 * instructions and `sha256("account:Policy")` for the account.
 *
 * Hardcoded rather than derived at call time so instruction builders stay
 * synchronous (WebCrypto's digest is async, and every other builder in this
 * codebase is sync). tests/unit/data/policy-program-v2.test.ts recomputes all
 * of them from sha256 and fails if any byte drifts, so these are checked
 * rather than trusted.
 */
const IX_INITIALIZE = new Uint8Array([175, 175, 109, 31, 13, 152, 155, 237]);
const IX_UPDATE_LIMITS = new Uint8Array([89, 37, 137, 60, 75, 70, 48, 194]);
const IX_AUTHORIZE = new Uint8Array([173, 193, 102, 210, 219, 137, 113, 120]);
const IX_AUTHORIZE_AND_INVOKE = new Uint8Array([225, 250, 173, 251, 78, 28, 228, 203]);
const IX_ASSUME_CUSTODY = new Uint8Array([66, 21, 51, 89, 235, 111, 62, 113]);
const IX_RELEASE_CUSTODY = new Uint8Array([162, 202, 238, 72, 152, 95, 225, 156]);
const IX_CUSTODY_MAINTENANCE = new Uint8Array([117, 21, 50, 68, 202, 37, 46, 177]);
const IX_SET_CONFIDENTIAL_LIMITS = new Uint8Array([48, 95, 194, 12, 110, 155, 5, 225]);
const IX_AUTHORIZE_CONFIDENTIAL = new Uint8Array([180, 29, 41, 254, 192, 166, 42, 212]);
const IX_AUTHORIZE_CONFIDENTIAL_AND_INVOKE = new Uint8Array([43, 28, 194, 169, 192, 58, 143, 70]);
const ACCOUNT_POLICY = new Uint8Array([222, 135, 7, 163, 235, 177, 33, 68]);

/**
 * discriminator(8) + owner(32) + agent(32) + 5 numeric fields(40) + bump(1)
 * + custodied_token_account(32) + limit_pubkey(32) + three ciphertexts(64 each).
 * Must match programs/agacy_policy_v2/src/state.rs.
 */
export const POLICY_V2_ACCOUNT_LEN = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 64 * 3;

const CONFIDENTIAL_FIELDS_AT = 145;

/** `Pubkey::default()` in the program — its "no custody held" sentinel. */
const NO_CUSTODY = "11111111111111111111111111111111";

/**
 * `@solana/kit` account roles, spelled out because the numeric literals used
 * across this codebase are otherwise unreadable at a glance.
 */
const READONLY = 0 as const;
const WRITABLE = 1 as const;
const READONLY_SIGNER = 2 as const;
const WRITABLE_SIGNER = 3 as const;

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

/**
 * The policy account's address for an (owner, agent) pair.
 *
 * Async because deriving a PDA means hashing until an off-curve address is
 * found — there is no synchronous form. Callers that need the address before
 * building instructions must await it first.
 */
export async function derivePolicyAddress(owner: Address, agent: Address): Promise<Address> {
  const [policyAddress] = await getProgramDerivedAddress({
    programAddress: POLICY_V2_PROGRAM_ID,
    seeds: [POLICY_SEED, addressEncoder.encode(owner), addressEncoder.encode(agent)],
  });
  return policyAddress;
}

export interface InitializePolicyV2Params {
  readonly policyAccount: Address;
  readonly owner: TransactionSigner;
  readonly agent: Address;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
}

/**
 * Creates and initializes the policy PDA in one instruction — unlike the
 * native program, which needed a separate System Program `createAccount`
 * first. Anchor's `init` does the allocation, so there is no
 * created-but-uninitialized state for anything to observe.
 */
export function buildInitializePolicyV2Instruction(params: InitializePolicyV2Params) {
  const data = new Uint8Array(8 + 32 + 8 + 8 + 8);
  const view = new DataView(data.buffer);

  data.set(IX_INITIALIZE, 0);
  data.set(addressEncoder.encode(params.agent), 8);
  view.setBigUint64(40, params.maxPerTransfer, true);
  view.setBigUint64(48, params.maxPerPeriod, true);
  view.setBigInt64(56, params.periodSeconds, true);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.owner.address, role: WRITABLE_SIGNER, signer: params.owner },
      { address: SYSTEM_PROGRAM_ID, role: READONLY },
    ],
    data,
  };
}

export interface AuthorizeSpendV2Params {
  readonly policyAccount: Address;
  readonly agent: TransactionSigner;
  readonly amount: bigint;
}

export function buildAuthorizeSpendV2Instruction(params: AuthorizeSpendV2Params) {
  const data = new Uint8Array(8 + 8);
  data.set(IX_AUTHORIZE, 0);
  new DataView(data.buffer).setBigUint64(8, params.amount, true);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.agent.address, role: READONLY_SIGNER, signer: params.agent },
    ],
    data,
  };
}

export interface UpdateLimitsV2Params {
  readonly policyAccount: Address;
  readonly owner: TransactionSigner;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
}

export function buildUpdateLimitsV2Instruction(params: UpdateLimitsV2Params) {
  const data = new Uint8Array(8 + 8 + 8);
  const view = new DataView(data.buffer);

  data.set(IX_UPDATE_LIMITS, 0);
  view.setBigUint64(8, params.maxPerTransfer, true);
  view.setBigUint64(16, params.maxPerPeriod, true);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.owner.address, role: READONLY_SIGNER, signer: params.owner },
    ],
    data,
  };
}

export interface CustodyParams {
  readonly policyAccount: Address;
  readonly owner: TransactionSigner;
  readonly tokenAccount: Address;
  readonly tokenProgram?: Address;
}

/**
 * Hands `tokenAccount`'s ownership to the policy PDA. Signed by the current
 * owner, who is still the account's authority at this point.
 *
 * This is the step Token-2022 confidential transfer requires and delegation
 * cannot substitute for — see programs/agacy_policy_v2/src/instructions/custody.rs.
 * It is also the step after which the owner can no longer reach the account
 * without this program, so callers should surface `buildReleaseCustodyInstruction`
 * in the same breath rather than treating it as an advanced option.
 */
export function buildAssumeCustodyInstruction(params: CustodyParams) {
  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.owner.address, role: READONLY_SIGNER, signer: params.owner },
      { address: params.tokenAccount, role: WRITABLE },
      { address: params.tokenProgram ?? TOKEN_2022_PROGRAM_ID, role: READONLY },
    ],
    data: IX_ASSUME_CUSTODY,
  };
}

export interface ReleaseCustodyParams extends CustodyParams {
  /** Who gets the account back. Usually the owner; a rescue wallet is valid. */
  readonly newAuthority: Address;
}

/** The recovery hatch. Owner-only, and refuses nothing on policy grounds. */
export function buildReleaseCustodyInstruction(params: ReleaseCustodyParams) {
  const data = new Uint8Array(8 + 32);
  data.set(IX_RELEASE_CUSTODY, 0);
  data.set(addressEncoder.encode(params.newAuthority), 8);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.owner.address, role: READONLY_SIGNER, signer: params.owner },
      { address: params.tokenAccount, role: WRITABLE },
      { address: params.tokenProgram ?? TOKEN_2022_PROGRAM_ID, role: READONLY },
    ],
    data,
  };
}

export interface ForwardedAccount {
  readonly address: Address;
  readonly role: 0 | 1 | 2 | 3;
}

export interface AuthorizeAndInvokeParams {
  readonly policyAccount: Address;
  readonly agent: TransactionSigner;
  readonly targetProgram: Address;
  readonly amount: bigint;
  /** The instruction the policy PDA will sign, forwarded verbatim. */
  readonly instructionData: Uint8Array;
  /** Accounts the forwarded instruction needs. Index 0 must be the source. */
  readonly forwardedAccounts: readonly ForwardedAccount[];
}

/**
 * Policy-gated CPI. The program refuses anything that is not a transfer on
 * SPL Token or Token-2022, and — while custody is held — anything whose first
 * forwarded account is not the custodied one.
 */
export function buildAuthorizeAndInvokeInstruction(params: AuthorizeAndInvokeParams) {
  const data = new Uint8Array(8 + 8 + 4 + params.instructionData.length);
  const view = new DataView(data.buffer);

  data.set(IX_AUTHORIZE_AND_INVOKE, 0);
  view.setBigUint64(8, params.amount, true);
  // Borsh `Vec<u8>`: u32 length prefix, then the bytes.
  view.setUint32(16, params.instructionData.length, true);
  data.set(params.instructionData, 20);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.agent.address, role: READONLY_SIGNER, signer: params.agent },
      { address: params.targetProgram, role: READONLY },
      ...params.forwardedAccounts.map((account) => ({
        address: account.address,
        role: account.role,
      })),
    ],
    data,
  };
}

export interface CustodyMaintenanceParams {
  readonly policyAccount: Address;
  readonly agent: TransactionSigner;
  readonly targetProgram: Address;
  readonly instructionData: Uint8Array;
  readonly forwardedAccounts: readonly ForwardedAccount[];
}

/**
 * Non-spending upkeep on a custodied account — in practice
 * `ApplyPendingBalance`, which only the account's authority can call and which
 * therefore becomes unreachable for the owner once the PDA holds custody.
 * Charges no policy budget.
 */
export function buildCustodyMaintenanceInstruction(params: CustodyMaintenanceParams) {
  const data = new Uint8Array(8 + 4 + params.instructionData.length);
  const view = new DataView(data.buffer);

  data.set(IX_CUSTODY_MAINTENANCE, 0);
  view.setUint32(8, params.instructionData.length, true);
  data.set(params.instructionData, 12);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: READONLY },
      { address: params.agent.address, role: READONLY_SIGNER, signer: params.agent },
      { address: params.targetProgram, role: READONLY },
      ...params.forwardedAccounts.map((account) => ({
        address: account.address,
        role: account.role,
      })),
    ],
    data,
  };
}

/** Solana's deployed proof verifier — every context account must be its output. */
export const ZK_ELGAMAL_PROOF_PROGRAM_ID = address("ZkE1Gama1Proof11111111111111111111111111111");

export interface SetConfidentialLimitsParams {
  readonly policyAccount: Address;
  readonly owner: TransactionSigner;
  /** 32-byte ElGamal pubkey the two ciphertexts below are encrypted under. */
  readonly limitPubkey: Uint8Array;
  readonly maxPerTransferCt: Uint8Array;
  readonly maxPerPeriodCt: Uint8Array;
}

/**
 * Replace a policy's visible limits with encrypted ones.
 *
 * One-directional by intent: there is no instruction to reveal them again,
 * because ciphertexts an observer already recorded do not become private
 * retroactively. Calling this again re-encrypts under a fresh key, which is the
 * operation that actually means something.
 */
export function buildSetConfidentialLimitsInstruction(params: SetConfidentialLimitsParams) {
  requireLength(params.limitPubkey, 32, "limitPubkey");
  requireLength(params.maxPerTransferCt, 64, "maxPerTransferCt");
  requireLength(params.maxPerPeriodCt, 64, "maxPerPeriodCt");

  const data = new Uint8Array(8 + 32 + 64 + 64);
  data.set(IX_SET_CONFIDENTIAL_LIMITS, 0);
  data.set(params.limitPubkey, 8);
  data.set(params.maxPerTransferCt, 40);
  data.set(params.maxPerPeriodCt, 104);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.owner.address, role: READONLY_SIGNER, signer: params.owner },
    ],
    data,
  };
}

export interface ConfidentialProofAccounts {
  /** Proves `max_per_transfer - amount` is the value in the range proof's first commitment. */
  readonly transferEqualityProof: Address;
  /** Proves `max_per_period - (spent + amount)` is the second. */
  readonly periodEqualityProof: Address;
  /** Proves both committed differences are non-negative. */
  readonly rangeProof: Address;
}

export interface AuthorizeConfidentialParams extends ConfidentialProofAccounts {
  readonly policyAccount: Address;
  readonly agent: TransactionSigner;
  readonly amountCiphertext: Uint8Array;
}

export function buildAuthorizeConfidentialInstruction(params: AuthorizeConfidentialParams) {
  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.agent.address, role: READONLY_SIGNER, signer: params.agent },
      ...proofAccountMetas(params),
    ],
    data: confidentialAmountData(IX_AUTHORIZE_CONFIDENTIAL, params.amountCiphertext),
  };
}

export interface AuthorizeConfidentialAndInvokeParams
  extends AuthorizeConfidentialParams {
  readonly targetProgram: Address;
  readonly instructionData: Uint8Array;
  readonly forwardedAccounts: readonly ForwardedAccount[];
}

/**
 * The confidential twin of `authorize_and_invoke`: same CPI allowlist and
 * custody rules on the program side, budget enforced over ciphertexts.
 */
export function buildAuthorizeConfidentialAndInvokeInstruction(
  params: AuthorizeConfidentialAndInvokeParams,
) {
  requireLength(params.amountCiphertext, 64, "amountCiphertext");

  const data = new Uint8Array(8 + 64 + 4 + params.instructionData.length);
  const view = new DataView(data.buffer);
  data.set(IX_AUTHORIZE_CONFIDENTIAL_AND_INVOKE, 0);
  data.set(params.amountCiphertext, 8);
  view.setUint32(72, params.instructionData.length, true);
  data.set(params.instructionData, 76);

  return {
    programAddress: POLICY_V2_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: WRITABLE },
      { address: params.agent.address, role: READONLY_SIGNER, signer: params.agent },
      { address: params.targetProgram, role: READONLY },
      ...proofAccountMetas(params),
      ...params.forwardedAccounts.map((account) => ({
        address: account.address,
        role: account.role,
      })),
    ],
    data,
  };
}

function proofAccountMetas(accounts: ConfidentialProofAccounts) {
  return [
    { address: accounts.transferEqualityProof, role: READONLY },
    { address: accounts.periodEqualityProof, role: READONLY },
    { address: accounts.rangeProof, role: READONLY },
  ];
}

function confidentialAmountData(discriminator: Uint8Array, amountCiphertext: Uint8Array) {
  requireLength(amountCiphertext, 64, "amountCiphertext");
  const data = new Uint8Array(8 + 64);
  data.set(discriminator, 0);
  data.set(amountCiphertext, 8);
  return data;
}

/**
 * Fails loudly on a wrong-sized ciphertext rather than letting it silently pad
 * to zeros — an all-zero ElGamal ciphertext is a perfectly valid encryption of
 * zero, so a truncated one would produce a confusing on-chain rejection far
 * from the actual mistake.
 */
function requireLength(bytes: Uint8Array, expected: number, name: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes, got ${bytes.length}`);
  }
}

export interface PolicyV2AccountState {
  readonly owner: string;
  readonly agent: string;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
  readonly spentInPeriod: bigint;
  readonly periodStart: bigint;
  readonly bump: number;
  /**
   * The token account this policy owns outright, or `null` in delegate mode.
   * `null` rather than the program's zero-pubkey sentinel, so callers cannot
   * accidentally treat "no custody" as a real address.
   */
  readonly custodiedTokenAccount: string | null;
  /**
   * When set, the visible `maxPerTransfer`/`maxPerPeriod`/`spentInPeriod`
   * fields above are stale leftovers and the operative limits are the
   * ciphertexts below. Callers must not present the plaintext numbers as the
   * policy in that case — the program itself refuses to enforce them.
   */
  readonly confidentialLimits: ConfidentialLimitCiphertexts | null;
}

export interface ConfidentialLimitCiphertexts {
  /** 32-byte ElGamal pubkey the three ciphertexts are encrypted under. */
  readonly limitPubkey: Uint8Array;
  readonly maxPerTransferCt: Uint8Array;
  readonly maxPerPeriodCt: Uint8Array;
  readonly spentInPeriodCt: Uint8Array;
}

/**
 * Read a policy account from chain and decode it. Returns `null` for "not
 * provisioned yet" rather than throwing, so callers do not have to
 * distinguish that from a real RPC failure by string-matching an error.
 */
export async function fetchPolicyV2Account(
  client: SolanaClient,
  policyAccount: Address,
): Promise<PolicyV2AccountState | null> {
  const { value } = await client.rpc
    .getAccountInfo(policyAccount, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!value) return null;

  const raw = value.data[0];
  const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  return decodePolicyV2Account(bytes);
}

export function decodePolicyV2Account(data: Uint8Array): PolicyV2AccountState {
  if (data.length < POLICY_V2_ACCOUNT_LEN) {
    throw new Error(`Policy account too small: ${data.length} < ${POLICY_V2_ACCOUNT_LEN}`);
  }
  for (let i = 0; i < ACCOUNT_POLICY.length; i++) {
    if (data[i] !== ACCOUNT_POLICY[i]) {
      throw new Error("Account is not an agacy_policy_v2 Policy");
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const custodied = addressDecoder.decode(data.slice(113, 145));

  const limitPubkey = data.slice(CONFIDENTIAL_FIELDS_AT, CONFIDENTIAL_FIELDS_AT + 32);
  // All-zero is the program's "confidential limits off" sentinel, matching
  // `Policy::has_confidential_limits`.
  const confidentialEnabled = limitPubkey.some((byte) => byte !== 0);

  return {
    owner: addressDecoder.decode(data.slice(8, 40)),
    agent: addressDecoder.decode(data.slice(40, 72)),
    maxPerTransfer: view.getBigUint64(72, true),
    maxPerPeriod: view.getBigUint64(80, true),
    periodSeconds: view.getBigInt64(88, true),
    spentInPeriod: view.getBigUint64(96, true),
    periodStart: view.getBigInt64(104, true),
    bump: data[112] as number,
    custodiedTokenAccount: custodied === NO_CUSTODY ? null : custodied,
    confidentialLimits: confidentialEnabled
      ? {
          limitPubkey,
          maxPerTransferCt: data.slice(CONFIDENTIAL_FIELDS_AT + 32, CONFIDENTIAL_FIELDS_AT + 96),
          maxPerPeriodCt: data.slice(CONFIDENTIAL_FIELDS_AT + 96, CONFIDENTIAL_FIELDS_AT + 160),
          spentInPeriodCt: data.slice(CONFIDENTIAL_FIELDS_AT + 160, CONFIDENTIAL_FIELDS_AT + 224),
        }
      : null,
  };
}
