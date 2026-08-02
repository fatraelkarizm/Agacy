import type { WalletProviderId } from "../dto/wallet.dto";

export function isWalletProviderId(value: unknown): value is WalletProviderId {
  return value === "phantom" || value === "solflare";
}
