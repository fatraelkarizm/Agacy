import type {
  WalletConnectionDTO,
  WalletProviderId,
  WalletProviderOptionDTO,
} from "../dto/wallet.dto";
import type {
  InjectedWalletMap,
  InjectedWalletProvider,
  InjectedWalletRegistry,
} from "../types/wallet-provider";

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
): Promise<WalletConnectionDTO> {
  const provider: InjectedWalletProvider | undefined = injectedWallets(registry)[providerId];
  if (!provider) throw new Error(`${providerId} extension is not installed.`);

  const response = await provider.connect();
  const publicKey = response?.publicKey ?? provider.publicKey;
  const address = publicKey?.toString().trim();
  if (!address) throw new Error(`${providerId} did not return a wallet address.`);

  return { provider: providerId, address, network: "devnet", connected: true };
}
