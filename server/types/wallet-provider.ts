import type { WalletProviderId } from "../dto/wallet.dto";

export interface WalletPublicKey {
  toString(): string;
}

/**
 * Whatever object the wallet extension hands back after it signs and submits
 * a transaction. Phantom and Solflare's legacy injected API both return a
 * base58 signature string here rather than raw bytes.
 */
export interface WalletSignAndSendResult {
  readonly signature: string;
}

export interface WalletSignMessageResult {
  readonly signature: Uint8Array;
}

/**
 * Structurally, not nominally, a `@solana/web3.js` `VersionedTransaction` —
 * this project does not import web3.js types into its own type layer, only
 * the shape the injected wallet's legacy `signAndSendTransaction` expects.
 */
export type InjectedWalletTransaction = unknown;

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
  /**
   * Not yet exercised against a real Phantom/Solflare extension in this
   * environment — see docs/INFRASTRUCTURE.md "Open Implementation Questions"
   * before trusting this path in a live demo.
   */
  signAndSendTransaction?(
    transaction: InjectedWalletTransaction,
  ): Promise<WalletSignAndSendResult>;
  signMessage?(
    message: Uint8Array,
    display?: "utf8" | "hex",
  ): Promise<WalletSignMessageResult | Uint8Array>;
}

export interface InjectedWalletRegistry {
  readonly phantom?: { readonly solana?: InjectedWalletProvider };
  readonly solflare?: InjectedWalletProvider;
  readonly solana?: InjectedWalletProvider;
}

export type InjectedWalletMap = Partial<Record<WalletProviderId, InjectedWalletProvider>>;

export type WalletSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
