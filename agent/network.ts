/**
 * Which cluster the autonomous agent is allowed to touch.
 *
 * Devnet is the default and requires no opt-in. Mainnet moves real money, so
 * it is deliberately awkward to reach: it needs an explicit env flag AND a
 * separate mainnet keypair, and it is never inferred from an RPC URL. A
 * misconfigured RPC should fail loudly rather than quietly spend real funds.
 *
 * docs/FEATURES.md lists "Mainnet deployment" as out of scope for Stage 1.
 * Mainnet support exists here only for the swap path (Jupiter has no devnet
 * endpoint at all), and every value-moving tool stays policy-gated on both
 * clusters — the spend policy is the constraint, not the cluster.
 */

export type Cluster = "devnet" | "mainnet";

/**
 * A subset of `NodeJS.ProcessEnv` rather than the real type: the real type
 * requires `NODE_ENV` to be present, which would force every caller
 * (including tests passing a plain literal) to fill in an unrelated field
 * just to satisfy the compiler.
 */
type EnvSource = Record<string, string | undefined>;

export interface NetworkConfig {
  readonly cluster: Cluster;
  readonly rpcUrl: string;
  /** True when a mistake here costs real money. */
  readonly usesRealFunds: boolean;
}

const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Resolve the cluster from the environment.
 *
 * Anything other than a literal `mainnet` opt-in resolves to devnet, including
 * typos — the failure mode of "meant mainnet, got devnet" is a confusing but
 * harmless error, while the reverse spends real money.
 */
export function resolveNetwork(env: EnvSource = process.env): NetworkConfig {
  const requested = env["AGACY_CLUSTER"]?.trim().toLowerCase();

  if (requested !== "mainnet") {
    return {
      cluster: "devnet",
      rpcUrl: env["AGACY_RPC_URL"]?.trim() || DEFAULT_DEVNET_RPC,
      usesRealFunds: false,
    };
  }

  // AGACY_RPC_URL is the devnet endpoint everywhere else in this codebase.
  // Reusing it for mainnet would silently send mainnet transactions to a
  // devnet RPC, so mainnet requires its own variable.
  const rpcUrl = env["AGACY_MAINNET_RPC_URL"]?.trim() || DEFAULT_MAINNET_RPC;

  return { cluster: "mainnet", rpcUrl, usesRealFunds: true };
}

/**
 * Second gate for real-money runs, separate from `resolveNetwork` so that
 * merely reading the config can never be mistaken for authorising a spend.
 *
 * Requires the operator to state a spend ceiling explicitly: an unbounded
 * "yes, mainnet" flag is exactly the kind of thing that gets left switched on.
 */
export interface MainnetAuthorization {
  readonly authorized: boolean;
  readonly maxSpendSol: number;
  readonly reason?: string;
}

export function authorizeMainnetRun(env: EnvSource = process.env): MainnetAuthorization {
  const confirmed = env["AGACY_MAINNET_CONFIRM"]?.trim() === "i-understand-this-spends-real-money";
  if (!confirmed) {
    return {
      authorized: false,
      maxSpendSol: 0,
      reason:
        "Mainnet runs require AGACY_MAINNET_CONFIRM=i-understand-this-spends-real-money. " +
        "Without it the agent will not touch real funds.",
    };
  }

  const raw = env["AGACY_MAINNET_MAX_SPEND_SOL"]?.trim();
  const maxSpendSol = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(maxSpendSol) || maxSpendSol <= 0) {
    return {
      authorized: false,
      maxSpendSol: 0,
      reason:
        "Mainnet runs require AGACY_MAINNET_MAX_SPEND_SOL set to a positive number — " +
        "an explicit ceiling, so an unattended run cannot drain the wallet.",
    };
  }

  return { authorized: true, maxSpendSol };
}
