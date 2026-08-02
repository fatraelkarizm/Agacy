import { connectInjectedWallet, detectInjectedWallets } from "../data/wallet-provider";
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
    return await connectInjectedWallet(provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wallet connection failed.";
    if (/reject|cancel/i.test(message)) {
      throw new Error("Connection request was cancelled. Your wallet remains disconnected.");
    }
    throw new Error(message);
  }
}
