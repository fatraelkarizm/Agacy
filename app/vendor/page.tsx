"use client";

import { CheckCircle, Copy, LockKey } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { VendorPaymentProfileDTO } from "../../server/dto/real-payment.dto";
import type { WalletConnectionDTO } from "../../server/dto/wallet.dto";
import { createDevnetClient } from "../../server/data/solana-client";
import { createVendorPaymentProfile } from "../../server/services/real-payment";
import { WalletGate } from "../WalletGate";

const client = createDevnetClient();

export default function VendorOnboardingPage() {
  const [wallet, setWallet] = useState<WalletConnectionDTO | null>(null);
  const [mint, setMint] = useState("");
  const [profile, setProfile] = useState<VendorPaymentProfileDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMint(new URLSearchParams(window.location.search).get("mint") ?? "");
  }, []);

  const provision = async () => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      setProfile(await createVendorPaymentProfile({ client, vendorWallet: wallet, mint }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vendor provisioning failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="vendor-page">
      <section className="vendor-shell">
        <div className="vendor-mark"><LockKey aria-hidden="true" size={24} weight="duotone" /></div>
        <span className="dashboard-label">Agacy vendor onboarding · Solana devnet</span>
        <h1>Provision a confidential payment address.</h1>
        <p className="vendor-lead">Your wallet signs the account setup and derives its viewing key locally. The owner receives only the public payment profile.</p>

        {!wallet ? (
          <WalletGate onConnected={setWallet} />
        ) : !profile ? (
          <div className="vendor-form">
            <label>
              Confidential mint
              <input value={mint} onChange={(event) => setMint(event.target.value)} placeholder="Token-2022 mint address" />
            </label>
            <p>Connected vendor: <code>{wallet.address}</code></p>
            <button className="primary" onClick={() => void provision()} disabled={busy || mint.length < 32}>
              {busy ? "Waiting for wallet…" : "Provision vendor account"}
            </button>
          </div>
        ) : (
          <div className="vendor-success">
            <CheckCircle aria-hidden="true" size={28} weight="fill" />
            <div><strong>Vendor account verified on devnet</strong><p>Copy this profile back to the Agacy owner. It contains no viewing secret.</p></div>
            <textarea readOnly rows={7} value={JSON.stringify(profile, null, 2)} />
            <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(profile))}>
              <Copy aria-hidden="true" size={16} /> Copy payment profile
            </button>
          </div>
        )}
        {error && <p className="wallet-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
