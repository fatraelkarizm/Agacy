import { address, type TransactionSendingSigner } from "@solana/kit";
import {
  connectInjectedWallet,
  detectInjectedWallets,
  disconnectInjectedWallet,
  forgetWalletProvider,
  readRememberedWalletProvider,
  rememberWalletProvider,
  signMessageWithInjectedWallet,
  watchInjectedWalletSession,
} from "../data/wallet-provider";
import { createWalletTransactionSigner } from "../data/wallet-signer";
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

/**
 * The signer that fee-pays and authorizes any transaction the owner needs to
 * approve (provisioning a policy account, later delegate-binding). Building
 * this from a connected `WalletConnectionDTO` rather than exposing the
 * injected provider keeps the same "one narrow surface" rule as the rest of
 * this file.
 */
export function getOwnerTransactionSigner(wallet: WalletConnectionDTO): TransactionSendingSigner {
  return createWalletTransactionSigner(address(wallet.address), wallet.provider);
}

export function signOwnerMessage(
  wallet: WalletConnectionDTO,
  message: Uint8Array,
): Promise<Uint8Array> {
  return signMessageWithInjectedWallet(wallet.provider, message);
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
