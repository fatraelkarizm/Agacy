import type { WalletProviderId } from "../dto/wallet.dto";

export interface WalletPublicKey {
  toString(): string;
}

export interface InjectedWalletProvider {
  readonly isPhantom?: boolean;
  readonly isSolflare?: boolean;
  readonly publicKey?: WalletPublicKey | null;
  connect(options?: { readonly onlyIfTrusted?: boolean }): Promise<
    { readonly publicKey?: WalletPublicKey } | void
  >;
  disconnect?(): Promise<void>;
  on?(event: "disconnect" | "accountChanged", listener: () => void): void;
  off?(event: "disconnect" | "accountChanged", listener: () => void): void;
}

export interface InjectedWalletRegistry {
  readonly phantom?: { readonly solana?: InjectedWalletProvider };
  readonly solflare?: InjectedWalletProvider;
  readonly solana?: InjectedWalletProvider;
}

export type InjectedWalletMap = Partial<Record<WalletProviderId, InjectedWalletProvider>>;

export type WalletSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
