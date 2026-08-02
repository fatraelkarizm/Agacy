import type { DashboardSessionDTO } from "../dto/session.dto";
import type { WalletSessionStorage } from "../types/wallet-provider";

/**
 * Raw storage read/write for the dashboard session. Pure data access, same
 * shape as `wallet-provider.ts`'s session helpers: best-effort, storage
 * failures (private browsing, quota) never throw into the caller.
 *
 * `DashboardSessionDTO` contains bigint fields (`SpendPolicyDTO`,
 * `AgentExecutionDTO`), which `JSON.stringify`/`parse` do not support
 * natively, so bigints are marshalled through a small marker convention
 * rather than pulling in a serialization library for two fields.
 */

const SESSION_KEY = "agacy.dashboard-session";
const BIGINT_MARKER = "__bigint__";

function browserStorage(): WalletSessionStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_MARKER]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && BIGINT_MARKER in value) {
    const encoded = (value as Record<string, unknown>)[BIGINT_MARKER];
    if (typeof encoded === "string") return BigInt(encoded);
  }
  return value;
}

export function readDashboardSession(
  storage: WalletSessionStorage | undefined = browserStorage(),
): DashboardSessionDTO | null {
  try {
    const raw = storage?.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw, reviver) as DashboardSessionDTO;
  } catch {
    return null;
  }
}

export function writeDashboardSession(
  session: DashboardSessionDTO,
  storage: WalletSessionStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(SESSION_KEY, JSON.stringify(session, replacer));
  } catch {
    // Persistence is best-effort; a full quota or private mode must not break the dashboard.
  }
}

export function clearDashboardSession(
  storage: WalletSessionStorage | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do if storage is unavailable — there is nothing to clear.
  }
}
