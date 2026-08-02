import type { WalletProviderId } from "../dto/wallet.dto";

export interface WalletPublicKey {
  toString(): string;
}

export interface InjectedWalletProvider {
  readonly isPhantom?: boolean;
  readonly isSolflare?: boolean;
  readonly publicKey?: WalletPublicKey | null;
  connect(): Promise<{ readonly publicKey?: WalletPublicKey } | void>;
}

export interface InjectedWalletRegistry {
  readonly phantom?: { readonly solana?: InjectedWalletProvider };
  readonly solflare?: InjectedWalletProvider;
  readonly solana?: InjectedWalletProvider;
}

export type InjectedWalletMap = Partial<Record<WalletProviderId, InjectedWalletProvider>>;
