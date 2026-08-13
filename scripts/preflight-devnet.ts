import "../tests/setup-env.js";
import { createDevnetClient, DEVNET_RPC_URL } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";

/**
 * Cheap connectivity and funding probe, so a long measurement run fails in two
 * seconds with a clear reason rather than halfway through creating accounts.
 *
 * Run with: npx tsx scripts/preflight-devnet.ts
 */

const client = createDevnetClient();
const payer = await loadOrCreatePayer();

console.log("rpc:", DEVNET_RPC_URL);
console.log("payer:", payer.address);

const started = Date.now();
const { value: lamports } = await client.rpc.getBalance(payer.address).send();
console.log("rpc round trip:", `${Date.now() - started}ms`);
console.log("balance:", `${(Number(lamports) / 1e9).toFixed(4)} SOL (${lamports} lamports)`);

// A full confidential transfer run creates a mint, two token accounts, three
// proof context accounts and ~6 transactions. Well under a tenth of a SOL in
// practice, but the floor is set high enough that a partial run cannot strand
// accounts halfway through.
const FLOOR = 200_000_000n;
if (lamports < FLOOR) {
  console.error(`\nUNDERFUNDED: need at least ${Number(FLOOR) / 1e9} SOL to run the measurement.`);
  console.error("Fund it with: solana airdrop 1", payer.address, "--url devnet");
  process.exit(1);
}
console.log("\nready");
