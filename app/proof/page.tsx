"use client";

import devnetProof from "../../server/data/devnet-proof.json";
import { POLICY_PROGRAM_ID } from "../../server/data/policy-program";

/**
 * Its own route rather than a `stage` on `/`: the whole point of this page is
 * to be an independently linkable/bookmarkable piece of evidence, not a step
 * in the demo flow.
 */
export default function ProofPage() {
  return (
    <div className="wrap step-page">
      <div className="step-head">
        <div className="step-index">On-chain evidence</div>
        <h2>Not a mockup. Verified on devnet.</h2>
        <p className="section-sub">
          Everything below runs for real on Solana devnet. Each claim is checked by reading the
          raw bytes back from chain, not asserted — open any link and verify it yourself.
        </p>
      </div>

      <div className="proof-grid">
        <ProofItem label="Transfer transaction" value={devnetProof.transferSignature} isTx />
        <ProofItem label="Confidential mint" value={devnetProof.mint} />
        <ProofItem label="Recipient account" value={devnetProof.recipientAccount} />
        <ProofItem label="Spend policy program" value={POLICY_PROGRAM_ID} />
        <div className="proof-item">
          <div className="proof-label">Amount readable on-chain</div>
          <div className="proof-verdict">
            {devnetProof.amountFoundInRecipientAccountData ? "yes" : "no, encrypted"}
          </div>
        </div>
      </div>

      <div className="step-head" style={{ marginTop: "2.5rem" }}>
        <h3>Not just the amount — the agent&apos;s reasoning too.</h3>
        <p className="section-sub">
          Confidential Transfer hides balances and amounts. It says nothing about why an agent
          made a payment. Agacy encrypts the agent&apos;s plain-language reasoning under a key only
          the owner holds, then carries the ciphertext on-chain in a memo — provably unreadable to
          anyone else, the same &quot;authorized-only&quot; property applied to the agent&apos;s
          decision, not just its balance.
        </p>
      </div>

      <div className="proof-grid">
        <ProofItem label="Reasoning memo transaction" value={devnetProof.reasoningMemoSignature} isTx />
        <div className="proof-item">
          <div className="proof-label">Reasoning readable in transaction bytes</div>
          <div className="proof-verdict">
            {devnetProof.reasoningFoundInTransaction ? "yes" : "no, encrypted"}
          </div>
        </div>
        <div className="proof-item">
          <div className="proof-label">Actual reasoning (owner-only)</div>
          <div className="proof-verdict" style={{ fontSize: "0.85rem", fontWeight: 400 }}>
            {devnetProof.reasoningPlaintext}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProofItem({ label, value, isTx }: { label: string; value: string; isTx?: boolean }) {
  const href = `https://explorer.solana.com/${isTx ? "tx" : "address"}/${value}?cluster=devnet`;
  return (
    <div className="proof-item">
      <div className="proof-label">{label}</div>
      <a className="proof-value" href={href} target="_blank" rel="noreferrer">
        {value.slice(0, 22)}…
      </a>
    </div>
  );
}
