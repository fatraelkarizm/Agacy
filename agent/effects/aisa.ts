/**
 * AIsa market data, reached through this app's own proxy route.
 *
 * Deliberately not calling api.aisa.one directly: AIsa authenticates with a
 * Bearer token and the Agent Graph runs its tools in the browser, so a direct
 * call would hand the key to anyone who opens devtools. app/api/aisa/price
 * holds the credential and returns only the price.
 *
 * The value of a second price source here is not redundancy for its own sake.
 * The agent is about to move money, and a single quote it cannot cross-check is
 * a single point of failure — a stale or manipulated feed becomes a payment.
 * Jupiter is a Solana DEX aggregator; AIsa fronts CoinGecko's aggregate. They
 * fail independently.
 */

export interface AisaTokenPrice {
  readonly mint: string;
  readonly priceUsd: number | null;
  readonly source: string;
}

export async function fetchAisaTokenPrice(mint: string): Promise<AisaTokenPrice> {
  const response = await fetch(`/api/aisa/price?mint=${encodeURIComponent(mint)}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AIsa price lookup failed: ${response.status}`);
  }
  return (await response.json()) as AisaTokenPrice;
}

export interface AisaResearchResult {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
}

export interface AisaResearch {
  readonly query: string;
  readonly results: readonly AisaResearchResult[];
  readonly source: string;
}

/**
 * Open-web research through AIsa, for the question that has no on-chain answer:
 * is there anything recent an owner would want to know before paying this
 * counterparty? Chain data says a transfer is possible; it cannot say the
 * recipient was compromised last week.
 */
export async function fetchAisaResearch(query: string): Promise<AisaResearch> {
  const response = await fetch("/api/aisa/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AIsa research failed: ${response.status}`);
  }
  return (await response.json()) as AisaResearch;
}

/**
 * How far apart two independent quotes are, as a percentage of their mean.
 *
 * Measured against the mean rather than either quote so the answer does not
 * depend on which source is treated as the reference — neither is authoritative.
 */
export function priceDivergencePercent(a: number, b: number): number {
  const mean = (a + b) / 2;
  return mean === 0 ? 0 : (Math.abs(a - b) / mean) * 100;
}
