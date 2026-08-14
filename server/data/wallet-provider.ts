import type {
  WalletConnectionDTO,
  WalletProviderId,
  WalletProviderOptionDTO,
} from "../dto/wallet.dto";
import type {
  InjectedWalletMap,
  InjectedWalletProvider,
  InjectedWalletRegistry,
  InjectedWalletTransaction,
  WalletSessionStorage,
  WalletSignAndSendResult,
  WalletSignMessageResult,
} from "../types/wallet-provider";
import { isWalletProviderId } from "../schema/wallet.schema";

const SESSION_KEY = "agacy.owner-wallet-provider";

const PROVIDERS: ReadonlyArray<Omit<WalletProviderOptionDTO, "installed">> = [
  {
    id: "phantom",
    name: "Phantom",
    installUrl: "https://phantom.com/download",
  },
  {
    id: "solflare",
    name: "Solflare",
    installUrl: "https://www.solflare.com/download/",
  },
];

function browserRegistry(): InjectedWalletRegistry {
  return typeof window === "undefined" ? {} : (window as unknown as InjectedWalletRegistry);
}

function browserStorage(): WalletSessionStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function injectedWallets(registry: InjectedWalletRegistry): InjectedWalletMap {
  const phantom = registry.phantom?.solana ??
    (registry.solana?.isPhantom ? registry.solana : undefined);
  const solflare = registry.solflare?.isSolflare ? registry.solflare : undefined;
  return { phantom, solflare };
}

export function detectInjectedWallets(
  registry: InjectedWalletRegistry = browserRegistry(),
): readonly WalletProviderOptionDTO[] {
  const wallets = injectedWallets(registry);
  return PROVIDERS.map((provider) => ({ ...provider, installed: Boolean(wallets[provider.id]) }));
}

export async function connectInjectedWallet(
  providerId: WalletProviderId,
  registry: InjectedWalletRegistry = browserRegistry(),
  onlyIfTrusted = false,
): Promise<WalletConnectionDTO> {
  const provider: InjectedWalletProvider | undefined = injectedWallets(registry)[providerId];
  if (!provider) throw new Error(`${providerId} extension is not installed.`);

  const response = await provider.connect(onlyIfTrusted ? { onlyIfTrusted: true } : undefined);
  const publicKey = response?.publicKey ?? provider.publicKey;
  const address = publicKey?.toString().trim();
  if (!address) throw new Error(`${providerId} did not return a wallet address.`);

  return { provider: providerId, address, network: "devnet", connected: true };
}

export function rememberWalletProvider(
  provider: WalletProviderId,
  storage: WalletSessionStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(SESSION_KEY, provider);
  } catch {
    // Session restore is best-effort; a private browser mode must not break connection.
  }
}

export function readRememberedWalletProvider(
  storage: WalletSessionStorage | undefined = browserStorage(),
): WalletProviderId | null {
  try {
    const provider = storage?.getItem(SESSION_KEY);
    return isWalletProviderId(provider) ? provider : null;
  } catch {
    return null;
  }
}

export function forgetWalletProvider(
  storage: WalletSessionStorage | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(SESSION_KEY);
  } catch {
    // Disconnect still succeeds when storage is unavailable.
  }
}

export async function disconnectInjectedWallet(
  providerId: WalletProviderId,
  registry: InjectedWalletRegistry = browserRegistry(),
): Promise<void> {
  await injectedWallets(registry)[providerId]?.disconnect?.();
}

export function watchInjectedWalletSession(
  providerId: WalletProviderId,
  onInvalidated: () => void,
  registry: InjectedWalletRegistry = browserRegistry(),
): () => void {
  const provider = injectedWallets(registry)[providerId];
  if (!provider?.on) return () => undefined;

  provider.on("disconnect", onInvalidated);
  provider.on("accountChanged", onInvalidated);
  return () => {
    provider.off?.("disconnect", onInvalidated);
    provider.off?.("accountChanged", onInvalidated);
  };
}

/**
 * Ask the extension to sign and submit a transaction it did not build itself.
 * Kept as a one-line wrapper (rather than exposing the raw provider) so every
 * other module reaches the wallet through the same narrow surface as
 * `connectInjectedWallet` — nothing outside this file touches the injected
 * global directly.
 */
export async function signAndSendWithInjectedWallet(
  providerId: WalletProviderId,
  transaction: InjectedWalletTransaction,
  registry: InjectedWalletRegistry = browserRegistry(),
): Promise<WalletSignAndSendResult> {
  const provider = injectedWallets(registry)[providerId];
  if (!provider) throw new Error(`${providerId} extension is not installed.`);
  if (!provider.signAndSendTransaction) {
    throw new Error(`${providerId} does not support signAndSendTransaction.`);
  }
  return provider.signAndSendTransaction(transaction);
}

export async function signMessageWithInjectedWallet(
  providerId: WalletProviderId,
  message: Uint8Array,
  registry: InjectedWalletRegistry = browserRegistry(),
): Promise<Uint8Array> {
  const provider = injectedWallets(registry)[providerId];
  if (!provider) throw new Error(`${providerId} extension is not installed.`);
  if (!provider.signMessage) throw new Error(`${providerId} does not support signMessage.`);

  const result: WalletSignMessageResult | Uint8Array = await provider.signMessage(message, "utf8");
  return result instanceof Uint8Array ? result : result.signature;
}
