import {
  connectInjectedWallet,
  detectInjectedWallets,
  disconnectInjectedWallet,
  forgetWalletProvider,
  readRememberedWalletProvider,
  rememberWalletProvider,
  watchInjectedWalletSession,
} from "../data/wallet-provider";
import type {
  WalletConnectionDTO,
  WalletProviderId,
  WalletProviderOptionDTO,
} from "../dto/wallet.dto";

export function getWalletOptions(): readonly WalletProviderOptionDTO[] {
  return detectInjectedWallets();
}

export async function connectOwnerWallet(
  provider: WalletProviderId,
): Promise<WalletConnectionDTO> {
  try {
    const connection = await connectInjectedWallet(provider);
    rememberWalletProvider(provider);
    return connection;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wallet connection failed.";
    if (/reject|cancel/i.test(message)) {
      throw new Error("Connection request was cancelled. Your wallet remains disconnected.");
    }
    throw new Error(message);
  }
}

export async function restoreOwnerWallet(): Promise<WalletConnectionDTO | null> {
  const provider = readRememberedWalletProvider();
  if (!provider) return null;

  try {
    return await connectInjectedWallet(provider, undefined, true);
  } catch {
    forgetWalletProvider();
    return null;
  }
}

export async function disconnectOwnerWallet(provider: WalletProviderId): Promise<void> {
  try {
    await disconnectInjectedWallet(provider);
  } finally {
    forgetWalletProvider();
  }
}

export function watchOwnerWalletSession(
  provider: WalletProviderId,
  onInvalidated: () => void,
): () => void {
  return watchInjectedWalletSession(provider, () => {
    forgetWalletProvider();
    onInvalidated();
  });
}
