import { describe, expect, it } from "vitest";
import { clearDashboardSessionFor, loadDashboardSession, saveDashboardSession } from "@services/session-state";
import type { DashboardSessionDTO } from "../../../server/dto/session.dto";
import type { WalletSessionStorage } from "../../../server/types/wallet-provider";

const OWNER = "7GgTn5S7y9i8xQJHWwRFd1tt9uDAah5i1oX55RxYFYxG";
const OTHER_OWNER = "3xSomeoneElse111111111111111111111111111111";

function storage(): WalletSessionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function session(ownerAddress: string): DashboardSessionDTO {
  return {
    ownerAddress,
    dashboardSection: "overview",
    onboardingStep: "define",
    setupDraft: {
      name: "Ops agent",
      purpose: "subscriptions",
      maxPerTransfer: 20,
      maxPerPeriod: 100,
      periodDays: 30,
      allowedRecipients: [],
      visibility: "confidential",
    },
    agent: null,
    policy: null,
    executed: [],
    provisionedPolicy: null,
    realTreasury: null,
    vendorProfile: null,
  };
}

describe("dashboard session restore", () => {
  it("returns the session when the owner address matches", () => {
    const store = storage();
    saveDashboardSession(session(OWNER), store);
    expect(loadDashboardSession(OWNER, store)?.ownerAddress).toBe(OWNER);
  });

  it("refuses to hand a session to a different wallet address", () => {
    const store = storage();
    saveDashboardSession(session(OWNER), store);
    expect(loadDashboardSession(OTHER_OWNER, store)).toBeNull();
  });

  it("returns null when nothing has been saved yet", () => {
    expect(loadDashboardSession(OWNER, storage())).toBeNull();
  });

  it("only clears a session that belongs to the given owner", () => {
    const store = storage();
    saveDashboardSession(session(OWNER), store);

    clearDashboardSessionFor(OTHER_OWNER, store);
    expect(loadDashboardSession(OWNER, store)).not.toBeNull();

    clearDashboardSessionFor(OWNER, store);
    expect(loadDashboardSession(OWNER, store)).toBeNull();
  });
});
