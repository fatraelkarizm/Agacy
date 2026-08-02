import { clearDashboardSession, readDashboardSession, writeDashboardSession } from "../data/session-store";
import type { DashboardSessionDTO } from "../dto/session.dto";
import type { WalletSessionStorage } from "../types/wallet-provider";

/**
 * Business rule for dashboard session restore: a persisted session is only
 * ever handed back to the wallet address it was written for. Without this
 * check, disconnecting and connecting a different wallet in the same browser
 * would silently inherit the previous owner's draft, agent, and policy.
 *
 * `storage` is only ever passed explicitly in tests; production callers rely
 * on the data layer's default (browser `localStorage`).
 */
export function loadDashboardSession(
  ownerAddress: string,
  storage?: WalletSessionStorage,
): DashboardSessionDTO | null {
  const session = readDashboardSession(storage);
  return session && session.ownerAddress === ownerAddress ? session : null;
}

export function saveDashboardSession(session: DashboardSessionDTO, storage?: WalletSessionStorage): void {
  writeDashboardSession(session, storage);
}

export function clearDashboardSessionFor(ownerAddress: string, storage?: WalletSessionStorage): void {
  const session = readDashboardSession(storage);
  if (session && session.ownerAddress === ownerAddress) clearDashboardSession(storage);
}
