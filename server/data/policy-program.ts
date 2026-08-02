import { address, type Address, type KeyPairSigner } from "@solana/kit";

/**
 * Client for the Agacy spend policy program.
 *
 * The program stores limits in an account it owns, so a limit is a property of
 * the account rather than a request the agent could ignore. This module builds
 * the instructions; it holds no policy opinions of its own.
 *
 * The byte layout is written out explicitly on both sides rather than derived
 * from a framework, so a change here that the program does not expect fails
 * loudly at the boundary instead of silently misreading a field.
 */

export const POLICY_PROGRAM_ID = address("AmJYcUrs36nwpiEZxJDB5q49LbXypBVujNVMvKMWg19e");

/** discriminator + owner + agent + 5 numeric fields — must match program/src/lib.rs. */
export const POLICY_ACCOUNT_LEN = 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8;

const IX_INITIALIZE = 0;
const IX_AUTHORIZE = 1;
const IX_UPDATE_LIMITS = 2;

export interface InitializePolicyParams {
  readonly policyAccount: Address;
  readonly owner: KeyPairSigner;
  readonly agent: Address;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
}

export function buildInitializePolicyInstruction(params: InitializePolicyParams) {
  const data = new Uint8Array(1 + 32 + 8 + 8 + 8);
  const view = new DataView(data.buffer);

  data[0] = IX_INITIALIZE;
  data.set(addressToBytes(params.agent), 1);
  view.setBigUint64(33, params.maxPerTransfer, true);
  view.setBigUint64(41, params.maxPerPeriod, true);
  view.setBigInt64(49, params.periodSeconds, true);

  return {
    programAddress: POLICY_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: 1 as const },
      { address: params.owner.address, role: 2 as const, signer: params.owner },
    ],
    data,
  };
}

export interface AuthorizeSpendParams {
  readonly policyAccount: Address;
  readonly agent: KeyPairSigner;
  readonly amount: bigint;
}

/**
 * The enforcement call. A transfer that cannot get past this instruction does
 * not happen, regardless of what the agent decided or was persuaded to decide.
 */
export function buildAuthorizeSpendInstruction(params: AuthorizeSpendParams) {
  const data = new Uint8Array(1 + 8);
  new DataView(data.buffer).setBigUint64(1, params.amount, true);
  data[0] = IX_AUTHORIZE;

  return {
    programAddress: POLICY_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: 1 as const },
      { address: params.agent.address, role: 2 as const, signer: params.agent },
    ],
    data,
  };
}

export interface UpdateLimitsParams {
  readonly policyAccount: Address;
  readonly owner: KeyPairSigner;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
}

export function buildUpdateLimitsInstruction(params: UpdateLimitsParams) {
  const data = new Uint8Array(1 + 8 + 8);
  const view = new DataView(data.buffer);

  data[0] = IX_UPDATE_LIMITS;
  view.setBigUint64(1, params.maxPerTransfer, true);
  view.setBigUint64(9, params.maxPerPeriod, true);

  return {
    programAddress: POLICY_PROGRAM_ID,
    accounts: [
      { address: params.policyAccount, role: 1 as const },
      { address: params.owner.address, role: 2 as const, signer: params.owner },
    ],
    data,
  };
}

export interface PolicyAccountState {
  readonly owner: string;
  readonly agent: string;
  readonly maxPerTransfer: bigint;
  readonly maxPerPeriod: bigint;
  readonly periodSeconds: bigint;
  readonly spentInPeriod: bigint;
  readonly periodStart: bigint;
}

const DISCRIMINATOR = 0xa6;

export function decodePolicyAccount(data: Uint8Array): PolicyAccountState {
  if (data.length < POLICY_ACCOUNT_LEN) {
    throw new Error(`Policy account too small: ${data.length} < ${POLICY_ACCOUNT_LEN}`);
  }
  if (data[0] !== DISCRIMINATOR) {
    throw new Error("Account is not an initialized Agacy policy");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    owner: bytesToBase58(data.slice(1, 33)),
    agent: bytesToBase58(data.slice(33, 65)),
    maxPerTransfer: view.getBigUint64(65, true),
    maxPerPeriod: view.getBigUint64(73, true),
    periodSeconds: view.getBigInt64(81, true),
    spentInPeriod: view.getBigUint64(89, true),
    periodStart: view.getBigInt64(97, true),
  };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function addressToBytes(value: Address): Uint8Array {
  let num = 0n;
  for (const char of value) {
    const index = BASE58.indexOf(char);
    if (index < 0) throw new Error(`Invalid base58 character in address: ${char}`);
    num = num * 58n + BigInt(index);
  }

  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(num & 0xffn);
    num >>= 8n;
  }

  // Leading '1's encode leading zero bytes and are lost by the numeric decode above.
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;
  for (let i = 0; i < leadingZeros; i++) bytes[i] = 0;

  return bytes;
}

function bytesToBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = (num << 8n) | BigInt(byte);

  let out = "";
  while (num > 0n) {
    out = BASE58[Number(num % 58n)] + out;
    num /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }

  return out || "1";
}
