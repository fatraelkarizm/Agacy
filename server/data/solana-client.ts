import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type RpcSubscriptions,
  type SolanaRpcSubscriptionsApi,
  type KeyPairSigner,
} from "@solana/kit";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thin RPC wiring. Everything here is transport concern only — no business
 * rules, no policy decisions, no DTO shaping. Callers get raw clients and are
 * expected to hand results up to the service layer for interpretation.
 */

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_WS_URL = "wss://api.devnet.solana.com";

export interface SolanaClient {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

export function createDevnetClient(
  httpUrl: string = DEVNET_RPC_URL,
  wsUrl: string = DEVNET_WS_URL,
): SolanaClient {
  return {
    rpc: createSolanaRpc(httpUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
  };
}

export async function createSigner(): Promise<KeyPairSigner> {
  return generateKeyPairSigner();
}

export async function signerFromSecretKey(secretKey: Uint8Array): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(secretKey);
}

/**
 * Request devnet SOL and wait until it lands.
 *
 * The public devnet faucet returns transient internal errors often enough that
 * a single attempt is unreliable, so this retries with backoff before giving
 * up. A final failure is reported as an infrastructure problem, not a code bug,
 * because that distinction matters when a test suite goes red.
 */
export async function fundFromFaucet(
  client: SolanaClient,
  address: Parameters<Rpc<SolanaRpcApi>["requestAirdrop"]>[0],
  lamports: bigint,
  attempts = 4,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await client.rpc
        .requestAirdrop(address, lamports as never, { commitment: "confirmed" })
        .send();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
  }

  throw new Error(
    `Devnet faucet failed ${attempts}x for ${String(address)}. This is usually rate limiting, ` +
      `not a code error — fund the account manually and set AGACY_PAYER_SECRET_KEY to reuse it.`,
    { cause: lastError },
  );
}

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

export async function getLamportBalance(
  client: SolanaClient,
  address: Parameters<Rpc<SolanaRpcApi>["getBalance"]>[0],
): Promise<bigint> {
  const { value } = await client.rpc.getBalance(address, { commitment: "confirmed" }).send();
  return BigInt(value);
}
