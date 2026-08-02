export type WalletProviderId = "phantom" | "solflare";

export type WalletConnectionPhase = "detecting" | "idle" | "connecting" | "error";

export interface WalletProviderOptionDTO {
  readonly id: WalletProviderId;
  readonly name: string;
  readonly installed: boolean;
  readonly installUrl: string;
}

export interface WalletConnectionDTO {
  readonly provider: WalletProviderId;
  readonly address: string;
  readonly network: "devnet";
  readonly connected: true;
}
