/**
 * Server-side proxy for AIsa's open-web search.
 *
 * Same reason as the price route: the Agent Graph runs its tools in the
 * browser, and AIsa authenticates with a Bearer token that must not be shipped
 * to the client.
 *
 * Every call here is billed against the AIsa account, so the request is capped
 * rather than passed through — an agent loop that could ask for fifty results
 * fifty times is a bill, not a feature. `basic` depth and a small result count
 * are the cheap end of Tavily's range and are enough to tell an owner whether
 * anything alarming has been written about a counterparty recently.
 */

const AISA_BASE = "https://api.aisa.one/apis/v1";
const MAX_RESULTS = 3;

interface TavilyResult {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
}

export async function POST(request: Request) {
  const apiKey = process.env["AISA_SECRET_KEY"];
  if (!apiKey) {
    return Response.json({ error: "AIsa is not configured" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as { query?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 200) {
    return Response.json({ error: "A query of 1-200 characters is required" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${AISA_BASE}/tavily/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: MAX_RESULTS,
        search_depth: "basic",
        topic: "news",
      }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });

    if (!upstream.ok) {
      // Upstream bodies can carry account state ("recharge required"); only the
      // status crosses back to the browser.
      return Response.json(
        { error: `AIsa research failed (${upstream.status})` },
        { status: 502 },
      );
    }

    const payload = (await upstream.json()) as { results?: readonly TavilyResult[] };
    const results = (payload.results ?? []).slice(0, MAX_RESULTS).map((result) => ({
      title: (result.title ?? "Untitled").slice(0, 140),
      url: result.url ?? "",
      // Trimmed hard: the graph shows a summary, and an untrimmed page excerpt
      // would dominate every node it appears in.
      excerpt: (result.content ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    }));

    return Response.json({ query, results, source: "AIsa / Tavily" });
  } catch {
    return Response.json({ error: "AIsa research failed" }, { status: 502 });
  }
}
