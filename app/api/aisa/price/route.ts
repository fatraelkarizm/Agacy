/**
 * Server-side proxy for AIsa's market data.
 *
 * The Agent Graph executes its tools in the browser (see `runGraphTool` in
 * app/dashboard/page.tsx), which is fine for Jupiter — its lite endpoint needs
 * no credential. AIsa authenticates with a Bearer token, so calling it from the
 * client would ship the key to every visitor. The key stays here and never
 * crosses to the browser; the client only ever sees a price.
 *
 * AIsa also exposes the same surface at /apis/v2 as x402 pay-per-call with no
 * registration. That path needs a funded machine wallet and a 402 retry loop,
 * which is a larger change than this demo needs — the keyed route below is the
 * same data.
 */

const AISA_BASE = "https://api.aisa.one/apis/v1";
/** Solana is the only asset platform this app deals in. */
const PLATFORM = "solana";

export async function GET(request: Request) {
  const apiKey = process.env["AISA_SECRET_KEY"];
  if (!apiKey) {
    return Response.json({ error: "AIsa is not configured" }, { status: 503 });
  }

  const mint = new URL(request.url).searchParams.get("mint")?.trim();
  // Base58 mints are 32-44 characters. Validated before it reaches the upstream
  // so a malformed value fails here rather than spending a call to find out.
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return Response.json({ error: "A base58 token mint address is required" }, { status: 400 });
  }

  const url =
    `${AISA_BASE}/coingecko/simple/token_price/${PLATFORM}` +
    `?contract_addresses=${encodeURIComponent(mint)}&vs_currencies=usd`;

  try {
    const upstream = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });

    if (!upstream.ok) {
      // The upstream body can carry account state ("recharge required") that is
      // not the browser's business, so only the status travels back.
      return Response.json(
        { error: `AIsa price lookup failed (${upstream.status})` },
        { status: 502 },
      );
    }

    const body = (await upstream.json()) as Record<string, { usd?: number } | undefined>;
    // CoinGecko lower-cases contract addresses in its response keys, so the
    // lookup cannot assume the caller's casing survived the round trip.
    const entry =
      body[mint] ??
      Object.entries(body).find(([key]) => key.toLowerCase() === mint.toLowerCase())?.[1];

    return Response.json({ mint, priceUsd: entry?.usd ?? null, source: "AIsa / CoinGecko" });
  } catch {
    return Response.json({ error: "AIsa price lookup failed" }, { status: 502 });
  }
}
