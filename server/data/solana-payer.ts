import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Node-only payer resolution for scripts and integration tests. Kept out of
 * solana-client.ts specifically so a browser bundle that imports client-safe
 * helpers (createDevnetClient, sendInstructionsWithSigner) never pulls in
 * node:fs/node:os/node:path — webpack fails outright if it does, since those
 * have no browser polyfill and none should be added just to satisfy a
 * bundler for code a browser will never run.
 */

/**
 * Resolve a funded payer, in order of preference:
 *   1. AGACY_PAYER_SECRET_KEY (JSON byte array)
 *   2. the Solana CLI's default keypair at ~/.config/solana/id.json
 *   3. a fresh keypair (which will need faucet funding)
 *
 * The CLI keypair fallback exists because the public devnet faucet rate-limits
 * aggressively; reusing an already-funded local keypair avoids depending on it.
 */
export async function loadOrCreatePayer(): Promise<KeyPairSigner> {
  const fromEnv = process.env["AGACY_PAYER_SECRET_KEY"];
  if (fromEnv) return signerFromJsonBytes(fromEnv, "AGACY_PAYER_SECRET_KEY");

  const cliKeypairPath = join(homedir(), ".config", "solana", "id.json");
  if (existsSync(cliKeypairPath)) {
    return signerFromJsonBytes(readFileSync(cliKeypairPath, "utf8"), cliKeypairPath);
  }

  return generateKeyPairSigner();
}

async function signerFromJsonBytes(raw: string, source: string): Promise<KeyPairSigner> {
  let bytes: number[];
  try {
    bytes = JSON.parse(raw) as number[];
  } catch (cause) {
    throw new Error(`${source} must contain a JSON array of secret key bytes`, { cause });
  }
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}
