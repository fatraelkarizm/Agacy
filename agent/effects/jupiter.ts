import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Jupiter market data and swap execution.
 *
 * Called over plain HTTP rather than through `@solana-agent-kit/plugin-token`
 * because that package cannot be imported in this ESM project at all — two of
 * its transitive dependencies (`@coral-xyz/anchor`, `@pump-fun/pump-sdk`) only
 * expose CommonJS named exports. The plugin would also drag in pump.fun,
 * Light Protocol, Mayan and Metaplex SDKs to reach one quote endpoint. The
 * REST API below is the same thing the plugin wraps.
 *
 * Jupiter is mainnet-only: there is no devnet router deployment, and quoting
 * against mainnet then "executing" on devnet would produce a transaction
 * referencing accounts that do not exist. Callers must not paper over that —
 * see `swap_tokens` in tools/toolkit.ts, which refuses on devnet rather than
 * simulating.
 */

// Both of these were caught by actually calling them, not by reading docs:
// quote-api.jup.ag/v6 (this file's original endpoint) and price/v2 are both
// retired as of Jupiter's October 1st deprecation — the old quote host no
// longer resolves in DNS at all, and the old price host 404s. lite-api's
// free tier replaces both with no API key required for the volumes this
// project needs.
const QUOTE_API = "https://lite-api.jup.ag/swap/v1";
// v3's response shape also differs from v2: no `data` wrapper, and the
// field is `usdPrice`, not `price`.
const PRICE_API = "https://api.jup.ag/price/v3";

export interface JupiterQuote {
  readonly inAmount: string;
  readonly outAmount: string;
  readonly priceImpactPct: string | null;
  /** Opaque quote object, passed back to the swap endpoint unmodified. */
  readonly raw: unknown;
}

export async function fetchTokenPrice(mint: string): Promise<{ mint: string; priceUsd: number | null }> {
  const response = await fetch(`${PRICE_API}?ids=${encodeURIComponent(mint)}`);
  if (!response.ok) {
    throw new Error(`Jupiter price lookup failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as Record<string, { usdPrice?: number } | undefined>;
  const price = body[mint]?.usdPrice;
  return { mint, priceUsd: price === undefined ? null : price };
}

export async function fetchSwapQuote(input: {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps?: number;
}): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amountLamports.toString(),
    slippageBps: String(input.slippageBps ?? 100),
  });

  const response = await fetch(`${QUOTE_API}/quote?${params}`);
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status} ${response.statusText}`);
  }
  const quote = (await response.json()) as {
    inAmount?: string;
    outAmount?: string;
    priceImpactPct?: string;
    error?: string;
  };
  if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);

  return {
    inAmount: quote.inAmount ?? "0",
    outAmount: quote.outAmount ?? "0",
    priceImpactPct: quote.priceImpactPct ?? null,
    raw: quote,
  };
}

/**
 * Execute a swap on mainnet. Spends real funds — every caller reaching this
 * has already passed the cluster check and SOL ceiling in tools/toolkit.ts and
 * the explicit operator confirmation in network.ts.
 */
export async function executeSwap(input: {
  connection: Connection;
  payer: Keypair;
  quote: JupiterQuote;
}): Promise<{ signature: string }> {
  const response = await fetch(`${QUOTE_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: input.quote.raw,
      userPublicKey: input.payer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Jupiter swap build failed: ${response.status} ${response.statusText}`);
  }

  const { swapTransaction } = (await response.json()) as { swapTransaction?: string };
  if (!swapTransaction) throw new Error("Jupiter returned no swap transaction");

  const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  transaction.sign([input.payer]);

  const signature = await input.connection.sendTransaction(transaction, {
    maxRetries: 3,
  });
  const { value } = await input.connection.confirmTransaction(signature, "confirmed");
  if (value.err) {
    throw new Error(`Swap landed but failed on-chain: ${JSON.stringify(value.err)}`);
  }

  return { signature };
}
