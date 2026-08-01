import { unwrapOption, type Address } from "@solana/kit";
import { fetchToken } from "@solana-program/token-2022";
import { ElGamalCiphertext, AeCiphertext } from "@solana/zk-sdk/node";
import type { SolanaClient } from "./solana-client.js";
import type { ConfidentialKeys } from "./confidential-keys.js";

/**
 * Reading an account's confidential balance state.
 *
 * This exists because proofs must be built over the *actual* on-chain
 * ciphertext, not a fresh local encryption of the same number. Two ElGamal
 * encryptions of the same value differ (different randomness), and the program
 * checks the proof against what it has stored — so a locally re-encrypted
 * balance produces a proof that verifies locally but is rejected on-chain.
 */

export interface ConfidentialBalanceState {
  /** Encrypted available balance, exactly as stored on-chain. */
  readonly availableBalanceCiphertext: ElGamalCiphertext;
  /** Owner-decryptable available balance. */
  readonly availableBalance: bigint;
  /** How many incoming transfers are waiting to be applied. */
  readonly pendingCreditCounter: bigint;
}

export async function fetchConfidentialBalance(
  client: SolanaClient,
  tokenAccount: Address,
  keys: ConfidentialKeys,
): Promise<ConfidentialBalanceState> {
  const account = await fetchToken(client.rpc, tokenAccount);

  const extensions = unwrapOption(account.data.extensions) ?? [];
  const extension = extensions.find((e) => e.__kind === "ConfidentialTransferAccount");

  if (!extension || extension.__kind !== "ConfidentialTransferAccount") {
    throw new Error(`Token account ${tokenAccount} is not configured for confidential transfers`);
  }

  const availableBalanceCiphertext = ElGamalCiphertext.fromBytes(
    toBytes(extension.availableBalance),
  );
  if (!availableBalanceCiphertext) {
    throw new Error(`Account ${tokenAccount} has a malformed encrypted available balance`);
  }

  const decryptable = AeCiphertext.fromBytes(toBytes(extension.decryptableAvailableBalance));
  const availableBalance = decryptable ? keys.ae.decrypt(decryptable) : 0n;

  return {
    availableBalanceCiphertext,
    availableBalance,
    pendingCreditCounter: extension.pendingBalanceCreditCounter,
  };
}

/** Extension fields come back as branded byte arrays; normalise to Uint8Array. */
function toBytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayLike<number>);
}
