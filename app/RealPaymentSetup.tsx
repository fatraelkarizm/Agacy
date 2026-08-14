"use client";

import { ArrowSquareOut, CheckCircle, Copy, LockKey, Wallet } from "@phosphor-icons/react";
import { useState } from "react";
import type { RealTreasuryDTO, VendorPaymentProfileDTO } from "../server/dto/real-payment.dto";

interface RealPaymentSetupProps {
  readonly treasury: RealTreasuryDTO | null;
  readonly vendor: VendorPaymentProfileDTO | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly ready: boolean;
  readonly agentReady: boolean;
  readonly sessionActive: boolean;
  readonly onCreateTreasury: (initialTokens: number) => void;
  readonly onImportVendor: (profile: string) => void;
  readonly onRecoverTreasury: () => void;
}

export function RealPaymentSetup({
  treasury,
  vendor,
  busy,
  error,
  ready,
  agentReady,
  sessionActive,
  onCreateTreasury,
  onImportVendor,
  onRecoverTreasury,
}: RealPaymentSetupProps) {
  const [initialTokens, setInitialTokens] = useState(10);
  const [profile, setProfile] = useState("");

  return (
    <section className="real-payment-setup" aria-labelledby="real-payment-title">
      <div className="real-payment-heading">
        <div>
          <span className="dashboard-label">Required before value can move</span>
          <h2 id="real-payment-title">Real devnet payment setup</h2>
          <p>Owner-funded treasury, vendor-provisioned recipient, and policy-PDA custody. No server demo wallet.</p>
        </div>
        <span className={ready ? "real-ready ready" : "real-ready"}>
          {ready ? "Ready" : treasury && !sessionActive ? "Session expired" : "Setup required"}
        </span>
      </div>

      <div className="real-payment-steps">
        <article className={treasury ? "complete" : ""}>
          <div className="real-step-index">01</div>
          <Wallet aria-hidden="true" size={24} weight="duotone" />
          <h3>Create owner treasury</h3>
          <p>Your connected wallet creates, funds, and hands a confidential Token-2022 account to the policy PDA.</p>
          {treasury ? (
            <>
              <div className="real-step-proof">
                <CheckCircle aria-hidden="true" size={17} weight="fill" />
                <span>{short(treasury.tokenAccount)} · {formatBaseUnits(treasury.balanceBaseUnits)} tokens</span>
                <a href={`https://explorer.solana.com/address/${treasury.tokenAccount}?cluster=devnet`} target="_blank" rel="noreferrer">
                  Explorer <ArrowSquareOut aria-hidden="true" size={14} />
                </a>
              </div>
              {!sessionActive && (
                <div className="real-step-action">
                  <p className="real-step-locked">The in-memory agent signer expired. Recover custody before creating a new treasury.</p>
                  <button onClick={onRecoverTreasury} disabled={busy}>
                    {busy ? "Waiting for wallet…" : "Recover custody to owner"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="real-step-action">
              <label>
                Initial devnet tokens
                <input
                  type="number"
                  min={1}
                  max={1_000}
                  value={initialTokens}
                  onChange={(event) => setInitialTokens(Number(event.target.value))}
                  disabled={busy}
                />
              </label>
              <button className="primary" onClick={() => onCreateTreasury(initialTokens)} disabled={busy || !agentReady}>
                {busy ? "Waiting for wallet…" : agentReady ? "Create real treasury" : "Recreate agent first"}
              </button>
            </div>
          )}
        </article>

        <article className={vendor ? "complete" : ""}>
          <div className="real-step-index">02</div>
          <LockKey aria-hidden="true" size={24} weight="duotone" />
          <h3>Import vendor profile</h3>
          <p>The vendor must connect its own wallet and provision a confidential account for this exact mint.</p>
          {vendor ? (
            <div className="real-step-proof">
              <CheckCircle aria-hidden="true" size={17} weight="fill" />
              <span>{short(vendor.walletAddress)} → {short(vendor.tokenAccount)}</span>
              <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(vendor))} title="Copy profile">
                <Copy aria-hidden="true" size={14} />
              </button>
            </div>
          ) : treasury ? (
            <div className="real-step-action vendor-import">
              <a className="secondary-link" href={`/vendor?mint=${treasury.mint}`} target="_blank" rel="noreferrer">
                Open vendor onboarding <ArrowSquareOut aria-hidden="true" size={15} />
              </a>
              <textarea
                value={profile}
                onChange={(event) => setProfile(event.target.value)}
                placeholder="Paste the vendor payment profile JSON"
                rows={3}
                disabled={busy}
              />
              <button onClick={() => onImportVendor(profile)} disabled={!profile.trim() || busy}>Verify profile</button>
            </div>
          ) : (
            <span className="real-step-locked">Create the owner treasury first.</span>
          )}
        </article>
      </div>
      {error && <p className="wallet-error" role="alert">{error}</p>}
    </section>
  );
}

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatBaseUnits(value: string): string {
  return (Number(value) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 6 });
}
