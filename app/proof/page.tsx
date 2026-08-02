"use client";

import devnetProof from "../../server/data/devnet-proof.json";

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
          Everything above runs for real. Below is an actual confidential transfer this codebase
          executed on Solana devnet: the transaction is public and confirmed, and the transferred
          amount is provably absent from the recipient&apos;s account data. Open any of them.
        </p>
      </div>

      <div className="proof-grid">
        <ProofItem label="Transfer transaction" value={devnetProof.transferSignature} isTx />
        <ProofItem label="Confidential mint" value={devnetProof.mint} />
        <ProofItem label="Recipient account" value={devnetProof.recipientAccount} />
        <ProofItem label="Spend policy program" value={devnetProof.policyProgramId} />
        <div className="proof-item">
          <div className="proof-label">Amount readable on-chain</div>
          <div className="proof-verdict">
            {devnetProof.amountFoundInRecipientAccountData ? "yes" : "no, encrypted"}
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
