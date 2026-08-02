/**
 * Encrypts an agent's plain-language reasoning so it is unreadable to
 * anyone but the party the owner authorizes — the same "only authorized
 * party can decrypt" property Confidential Transfer gives amounts, applied
 * to the agent's decision rationale instead.
 *
 * This is deliberately a *different* primitive from `confidential-keys.ts`'s
 * AE key: that key is Solana's ZK ElGamal AE scheme, purpose-built to
 * encrypt a single bigint balance, not arbitrary-length text. Reasoning is
 * free-form, so it's encrypted with standard AES-GCM via the Web Crypto API
 * (native in both the browser and Node — no new dependency), using a key
 * derived from the same kind of wallet signature the confidential keys use,
 * domain-separated so the two derivations can never collide into the same
 * key material.
 */

const DOMAIN_LABEL = new TextEncoder().encode("agacy-reasoning-v1");
const IV_LENGTH = 12;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Derive a reasoning-encryption key from a wallet signature. Same signature
 * in, same key out — nothing to back up beyond the wallet itself, matching
 * how `deriveConfidentialKeys` works.
 */
export async function deriveReasoningKey(signature: Uint8Array): Promise<CryptoKey> {
  if (signature.length !== 64) {
    throw new Error(`Expected a 64-byte ed25519 signature, got ${signature.length} bytes`);
  }
  const material = await crypto.subtle.digest(
    "SHA-256",
    concatBytes(signature, DOMAIN_LABEL) as BufferSource,
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt reasoning text. Returns `iv || ciphertext` as one blob — the IV is
 * not secret, it just has to travel with the ciphertext to decrypt it, so
 * keeping them together is simpler than a separate side channel.
 */
export async function encryptReasoning(key: CryptoKey, reasoning: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(reasoning);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  return concatBytes(iv, ciphertext);
}

/**
 * Decrypt a payload produced by `encryptReasoning`. Throws if the key is
 * wrong or the payload was tampered with — AES-GCM's authentication tag
 * makes silent corruption impossible to miss.
 */
export async function decryptReasoning(key: CryptoKey, payload: Uint8Array): Promise<string> {
  const iv = payload.slice(0, IV_LENGTH);
  const ciphertext = payload.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
