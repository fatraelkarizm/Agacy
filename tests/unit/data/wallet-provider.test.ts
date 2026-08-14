import { describe, expect, it, vi } from "vitest";
import {
  connectInjectedWallet,
  detectInjectedWallets,
  disconnectInjectedWallet,
  forgetWalletProvider,
  readRememberedWalletProvider,
  rememberWalletProvider,
  signMessageWithInjectedWallet,
  watchInjectedWalletSession,
} from "@data/wallet-provider";
import type {
  InjectedWalletRegistry,
  WalletSessionStorage,
} from "../../../server/types/wallet-provider";

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

function sessionStorage(): WalletSessionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
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

  it("uses a trusted-only request when restoring a session", async () => {
    const connect = vi.fn(async () => undefined);
    const wallets: InjectedWalletRegistry = {
      phantom: { solana: { isPhantom: true, publicKey: { toString: () => ADDRESS }, connect } },
    };

    await connectInjectedWallet("phantom", wallets, true);
    expect(connect).toHaveBeenCalledWith({ onlyIfTrusted: true });
  });

  it("stores only a validated provider id for session restore", () => {
    const storage = sessionStorage();
    rememberWalletProvider("phantom", storage);
    expect(readRememberedWalletProvider(storage)).toBe("phantom");
    forgetWalletProvider(storage);
    expect(readRememberedWalletProvider(storage)).toBeNull();
  });

  it("disconnects the extension and cleans up session listeners", async () => {
    const disconnect = vi.fn(async () => undefined);
    const on = vi.fn();
    const off = vi.fn();
    const wallets: InjectedWalletRegistry = {
      phantom: {
        solana: {
          isPhantom: true,
          publicKey: { toString: () => ADDRESS },
          connect: vi.fn(async () => undefined),
          disconnect,
          on,
          off,
        },
      },
    };
    const invalidate = vi.fn();
    const stop = watchInjectedWalletSession("phantom", invalidate, wallets);

    await disconnectInjectedWallet("phantom", wallets);
    stop();

    expect(disconnect).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenCalledTimes(2);
  });

  it("normalizes Phantom and Solflare message-signature response shapes", async () => {
    const signature = new Uint8Array(64).fill(7);
    const phantom = registry();
    phantom.phantom!.solana!.signMessage = vi.fn(async () => ({ signature }));
    await expect(signMessageWithInjectedWallet("phantom", new Uint8Array([1]), phantom))
      .resolves.toEqual(signature);

    const solflare: InjectedWalletRegistry = {
      solflare: {
        isSolflare: true,
        connect: vi.fn(async () => undefined),
        signMessage: vi.fn(async () => signature),
      },
    };
    await expect(signMessageWithInjectedWallet("solflare", new Uint8Array([1]), solflare))
      .resolves.toEqual(signature);
  });
});
