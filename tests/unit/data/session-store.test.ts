import { describe, expect, it } from "vitest";
import { clearDashboardSession, readDashboardSession, writeDashboardSession } from "@data/session-store";
import type { DashboardSessionDTO } from "../../../server/dto/session.dto";
import type { WalletSessionStorage } from "../../../server/types/wallet-provider";

const OWNER = "7GgTn5S7y9i8xQJHWwRFd1tt9uDAah5i1oX55RxYFYxG";

function storage(): WalletSessionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function session(overrides: Partial<DashboardSessionDTO> = {}): DashboardSessionDTO {
  return {
    ownerAddress: OWNER,
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
    ...overrides,
  };
}

describe("dashboard session store", () => {
  it("round-trips a session including bigint fields", () => {
    const store = storage();
    const withBigints = session({
      policy: { maxPerTransfer: 20_000_000n, maxPerPeriod: 100_000_000n, allowedRecipients: [] },
      executed: [{ amount: 4_200_000n, recipient: "Recipient111", reasoning: "test" }],
    });

    writeDashboardSession(withBigints, store);
    const restored = readDashboardSession(store);

    expect(restored).toEqual(withBigints);
    expect(typeof restored?.policy?.maxPerTransfer).toBe("bigint");
    expect(typeof restored?.executed[0]?.amount).toBe("bigint");
  });

  it("returns null when nothing is stored", () => {
    expect(readDashboardSession(storage())).toBeNull();
  });

  it("returns null for corrupted stored data instead of throwing", () => {
    const store = storage();
    store.setItem("agacy.dashboard-session", "{not json");
    expect(readDashboardSession(store)).toBeNull();
  });

  it("clears the stored session", () => {
    const store = storage();
    writeDashboardSession(session(), store);
    clearDashboardSession(store);
    expect(readDashboardSession(store)).toBeNull();
  });
});
