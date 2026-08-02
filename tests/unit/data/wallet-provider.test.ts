import { describe, expect, it, vi } from "vitest";
import { connectInjectedWallet, detectInjectedWallets } from "@data/wallet-provider";
import type { InjectedWalletRegistry } from "../../../server/types/wallet-provider";

const ADDRESS = "7GgTn5S7y9i8xQJHWwRFd1tt9uDAah5i1oX55RxYFYxG";

function registry(): InjectedWalletRegistry {
  return {
    phantom: {
      solana: {
        isPhantom: true,
        publicKey: { toString: () => ADDRESS },
        connect: vi.fn(async () => undefined),
      },
    },
  };
}

describe("injected wallet provider", () => {
  it("detects supported extensions independently", () => {
    expect(detectInjectedWallets(registry()).map(({ id, installed }) => [id, installed])).toEqual([
      ["phantom", true],
      ["solflare", false],
    ]);
  });

  it("returns only the public connection DTO", async () => {
    await expect(connectInjectedWallet("phantom", registry())).resolves.toEqual({
      provider: "phantom",
      address: ADDRESS,
      network: "devnet",
      connected: true,
    });
  });

  it("fails clearly when an extension is missing", async () => {
    await expect(connectInjectedWallet("solflare", registry())).rejects.toThrow(/not installed/);
  });
});
