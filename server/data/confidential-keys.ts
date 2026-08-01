import { ElGamalKeypair, AeKey, type AeCiphertext } from "@solana/zk-sdk/node";

/**
 * Confidential-transfer keys are *derived*, never stored.
 *
 * Solana's confidential transfer scheme uses two keys per account:
 *  - ElGamal keypair: homomorphic encryption of balances, so the chain can add
 *    incoming transfers to an encrypted balance without decrypting it.
 *  - AE (authenticated encryption) key: encrypts the owner's own "available
 *    balance" so the owner can read it back cheaply without a discrete-log solve.
 *
 * Both are derived deterministically from a signature over a fixed message, so
 * the owner can always re-derive them from their wallet — nothing extra to back up,
 * and the agent never needs custody of a long-lived secret it could leak.
 */

export interface ConfidentialKeys {
  readonly elGamal: ElGamalKeypair;
  readonly ae: AeKey;
}

/** The message a wallet signs to derive its confidential-transfer keys. */
export function keyDerivationMessage(publicSeed: Uint8Array): Uint8Array {
  return ElGamalKeypair.signerMessage(publicSeed);
}

/**
 * Derive both confidential keys from a wallet signature.
 * Same signature in => same keys out, always.
 */
export function deriveConfidentialKeys(signature: Uint8Array): ConfidentialKeys {
  if (signature.length !== 64) {
    throw new Error(`Expected a 64-byte ed25519 signature, got ${signature.length} bytes`);
  }
  return {
    elGamal: ElGamalKeypair.fromSignature(signature),
    ae: AeKey.fromSignature(signature),
  };
}

/** Encrypt an amount under the owner's AE key (used for the available balance). */
export function encryptBalance(keys: ConfidentialKeys, amount: bigint): AeCiphertext {
  return keys.ae.encrypt(amount);
}

/** Decrypt an AE-encrypted balance back to a plain amount. */
export function decryptBalance(keys: ConfidentialKeys, ciphertext: AeCiphertext): bigint {
  return keys.ae.decrypt(ciphertext);
}

/** The ElGamal public key others use to send this account confidential transfers. */
export function elGamalPubkeyBytes(keys: ConfidentialKeys): Uint8Array {
  return keys.elGamal.pubkey().toBytes();
}
