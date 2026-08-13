import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type RpcSubscriptions,
  type SolanaRpcSubscriptionsApi,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";

/**
 * Thin RPC wiring. Everything here is transport concern only — no business
 * rules, no policy decisions, no DTO shaping. Callers get raw clients and are
 * expected to hand results up to the service layer for interpretation.
 *
 * Browser-safe by design: nothing here imports a Node built-in. Node-only
 * payer resolution (reading a local keypair file) lives in solana-payer.ts
 * instead, so this file can be imported from a client component without
 * webpack choking on node:fs/node:os/node:path.
 */

/**
 * Devnet endpoint. Overridable via AGACY_RPC_URL because the public endpoint
 * rate-limits hard, and a confidential transfer needs several transactions in
 * quick succession (three proof verifications, the transfer, then cleanup).
 */
/**
 * A Helius dashboard hands you an API key, not an endpoint, so pasting the key
 * straight into AGACY_RPC_URL is the natural mistake. It was already handled in
 * tests/setup-env.ts — but only scripts import that file, so the Next server
 * read the bare key and every RPC call died on "Failed to parse URL from
 * <uuid>". Normalising here means both runtimes agree.
 */
const HELIUS_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveEndpoint(configured: string | undefined, scheme: "https" | "wss"): string | null {
  if (!configured) return null;
  return HELIUS_KEY.test(configured)
    ? `${scheme}://devnet.helius-rpc.com/?api-key=${configured}`
    : configured;
}

export const DEVNET_RPC_URL =
  resolveEndpoint(process.env["AGACY_RPC_URL"], "https") ?? "https://api.devnet.solana.com";
export const DEVNET_WS_URL =
  resolveEndpoint(process.env["AGACY_WS_URL"] ?? process.env["AGACY_RPC_URL"], "wss") ??
  "wss://api.devnet.solana.com";

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
 * Compile, sign, and send a transaction for an arbitrary `TransactionSigner`
 * fee payer — a wallet-backed `TransactionSendingSigner` as well as a plain
 * `KeyPairSigner`. Kept separate from `confidential-mint.ts`'s `sendInstructions`,
 * which is specifically shaped for the Node-script rate-limit-retry flow used
 * to run several proof-verification transactions back to back; this is the
 * general one-shot path for anything signed through a connected wallet.
 */
export async function sendInstructionsWithSigner(
  client: SolanaClient,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
): Promise<string> {
  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  const signatureBytes = await signAndSendTransactionMessageWithSigners(message);
  return getBase58Decoder().decode(signatureBytes);
}

export async function getLamportBalance(
  client: SolanaClient,
  address: Parameters<Rpc<SolanaRpcApi>["getBalance"]>[0],
): Promise<bigint> {
  const { value } = await client.rpc.getBalance(address, { commitment: "confirmed" }).send();
  return BigInt(value);
}
