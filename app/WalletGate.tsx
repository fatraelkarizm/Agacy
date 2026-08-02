"use client";

import { useEffect, useState } from "react";
import type {
  WalletConnectionDTO,
  WalletConnectionPhase,
  WalletProviderId,
  WalletProviderOptionDTO,
} from "../server/dto/wallet.dto";
import { connectOwnerWallet, getWalletOptions } from "../server/services/wallet-connection";

interface WalletGateProps {
  readonly onConnected: (wallet: WalletConnectionDTO) => void;
}

export function WalletGate({ onConnected }: WalletGateProps) {
  const [providers, setProviders] = useState<readonly WalletProviderOptionDTO[]>([]);
  const [phase, setPhase] = useState<WalletConnectionPhase>("detecting");
  const [connecting, setConnecting] = useState<WalletProviderId | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setProviders(getWalletOptions());
    setPhase("idle");
  }, []);

  const connect = async (provider: WalletProviderId) => {
    setConnecting(provider);
    setPhase("connecting");
    setError("");
    try {
      onConnected(await connectOwnerWallet(provider));
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : "Connection failed.");
      setPhase("error");
    } finally {
      setConnecting(null);
    }
  };

  return (
    <section className="card wallet-gate" aria-busy={phase === "detecting"}>
      <div className="wallet-network">
        <span aria-hidden="true" />
        <strong>Solana devnet</strong>
        <small>This build only prepares and submits devnet transactions.</small>
      </div>
      <div className="wallet-list">
        {phase === "detecting" && <p className="hint">Checking browser wallet extensions...</p>}
        {providers.map((provider) => (
          <article className="wallet-option" key={provider.id}>
            <span className={`wallet-logo ${provider.id}`} aria-hidden="true">
              {provider.name.slice(0, 1)}
            </span>
            <span className="wallet-copy">
              <strong>{provider.name}</strong>
              <span>{provider.installed ? "Extension detected" : "Extension not detected"}</span>
            </span>
            {provider.installed ? (
              <button
                className="primary"
                disabled={phase === "connecting"}
                onClick={() => void connect(provider.id)}
              >
                {connecting === provider.id ? "Connecting..." : "Connect"}
              </button>
            ) : (
              <a className="wallet-install" href={provider.installUrl} target="_blank" rel="noreferrer">
                Install
              </a>
            )}
          </article>
        ))}
      </div>

      {error && <p className="wallet-error" role="alert">{error}</p>}

      <div className="wallet-safety">
        <strong>Your wallet stays in control.</strong>
        <span>
          Agacy never asks for a seed phrase or private key. Connecting proves ownership; it does
          not give an agent permission to spend.
        </span>
      </div>
    </section>
  );
}
