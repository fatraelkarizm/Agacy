import { existsSync, readFileSync } from "node:fs";

/**
 * Load .env.local for integration runs.
 *
 * AGACY_RPC_URL accepts either a full endpoint or just a Helius API key — the
 * key alone is what you get from their dashboard, and pasting it directly is
 * the mistake anyone would make, so it is normalised here rather than failing
 * later with a confusing connection error.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    process.env[key] ??= rawValue.trim();
  }
}

const rpc = process.env["AGACY_RPC_URL"];
if (rpc && UUID.test(rpc)) {
  process.env["AGACY_RPC_URL"] = `https://devnet.helius-rpc.com/?api-key=${rpc}`;
  process.env["AGACY_WS_URL"] ??= `wss://devnet.helius-rpc.com/?api-key=${rpc}`;
}
