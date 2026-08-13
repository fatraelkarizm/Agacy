"use client";

import devnetProof from "../../server/data/devnet-proof.json";
import autonomousProof from "../../server/data/autonomous-agent-proof.json";
import custodyProof from "../../server/data/custody-proof.json";
import confidentialLimitsProof from "../../server/data/confidential-limits-proof.json";
import { POLICY_V2_PROGRAM_ID } from "../../server/data/policy-program-v2";

interface AutonomousStep {
  readonly tool: string;
  readonly outcome: "allowed" | "refused";
  readonly reason?: string;
}

interface CustodyCheck {
  readonly step: string;
  readonly expected: string;
  readonly observed: string;
  readonly ok: boolean;
}

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

      <section className="encryption-proof" aria-labelledby="encryption-proof-title">
        <div className="encryption-proof-head">
          <div>
            <div className="step-index">Cryptographic proof chain</div>
            <h3 id="encryption-proof-title">Don&apos;t trust the UI. Check the chain.</h3>
          </div>
          <span className="encryption-proof-status">4 protected fields verified</span>
        </div>

        <div className="encryption-proof-flow">
          <ProofStep
            number="01"
            title="Known plaintext"
            detail={`${formatTokens(devnetProof.transferAmount)} tokens plus a known reasoning sentence.`}
          />
          <ProofStep
            number="02"
            title="Committed to devnet"
            detail="A real Token-2022 confidential transfer and encrypted memo landed on-chain."
          />
          <ProofStep
            number="03"
            title="Public bytes inspected"
            detail="Neither the amount nor the reasoning plaintext appears in the raw account or transaction bytes."
          />
          <ProofStep
            number="04"
            title="Owner-key readback"
            detail="An independent devnet transfer decrypts to sender 7.5 and recipient 2.5 tokens from chain."
          />
        </div>

        <div className="privacy-boundary" aria-label="Agacy privacy boundary">
          <PrivacyBoundaryItem
            label="Transfer amount & balances"
            technology="Token-2022 confidential transfer / ElGamal"
            isPrivate
          />
          <PrivacyBoundaryItem
            label="Agent reasoning"
            technology="Owner-key ciphertext in Memo"
            isPrivate
          />
          <PrivacyBoundaryItem
            label="Spend limits"
            technology="ElGamal + verified range proofs"
            isPrivate
          />
          <PrivacyBoundaryItem
            label="Addresses, mint, timing & fees"
            technology="Visible Solana metadata"
            isPrivate={false}
          />
        </div>

        <div className="encryption-proof-links">
          <ProofItem label="Inspect transfer" value={devnetProof.transferSignature} isTx />
          <ProofItem label="Inspect encrypted reasoning" value={devnetProof.reasoningMemoSignature} isTx />
          <ProofItem label="Inspect owner-key readback" value={custodyProof.signatures.confidentialTransfer} isTx />
        </div>
      </section>

      <div className="proof-grid">
        <ProofItem label="Transfer transaction" value={devnetProof.transferSignature} isTx />
        <ProofItem label="Confidential mint" value={devnetProof.mint} />
        <ProofItem label="Recipient account" value={devnetProof.recipientAccount} />
        <ProofItem label="Spend policy program" value={POLICY_V2_PROGRAM_ID} />
        <div className="proof-item">
          <div className="proof-label">Amount readable on-chain</div>
          <div className="proof-verdict">
            {devnetProof.amountFoundInRecipientAccountData ? "yes" : "no, encrypted"}
          </div>
        </div>
      </div>

      <div className="step-head" style={{ marginTop: "2.5rem" }}>
        <h3>The policy checks the encrypted transfer, not the agent&apos;s claim.</h3>
        <p className="section-sub">
          A malicious run supplied a valid policy proof for one token beside a valid encrypted
          transfer for twenty-five. The deployed program derived the real ciphertext from
          Token-2022&apos;s proof context, rejected the mismatch, and moved nothing.
        </p>
      </div>

      <div className="proof-grid">
        <ProofItem label="Amount-bound policy account" value={autonomousProof.policyAccount} />
        <ProofItem
          label="Claimed amount"
          value={formatTokens(autonomousProof.amountClaimAttack.claimedAmount)}
        />
        <ProofItem
          label="Encrypted transfer amount"
          value={formatTokens(autonomousProof.amountClaimAttack.encryptedTransferAmount)}
        />
        <div className="proof-item">
          <div className="proof-label">On-chain result</div>
          <div className="proof-verdict">
            {autonomousProof.amountClaimAttack.rejectedOnChain &&
            autonomousProof.amountClaimAttack.vendorBalanceAfter === "0"
              ? "rejected, vendor balance stayed zero"
              : "UNEXPECTED RESULT"}
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

      <div className="step-head" style={{ marginTop: "2.5rem" }}>
        <h3>The agent chose its own moves — not a script.</h3>
        <p className="section-sub">
          Given a goal, not a task list, the model below picked its own tools, sequence, and
          stopping point. Two real runs against live devnet, captured the same way as the evidence
          above — re-run <code>npm run agent</code> any time to refresh this against a fresh model call.
        </p>
      </div>

      <div className="proof-item" style={{ marginBottom: "1rem" }}>
        <div className="proof-label">Goal given to the agent</div>
        <div className="proof-verdict" style={{ fontSize: "0.85rem", fontWeight: 400 }}>
          {autonomousProof.phase1.goal}
        </div>
      </div>
      <AutonomousConsole steps={autonomousProof.phase1.steps as AutonomousStep[]} />
      <div className="proof-grid" style={{ marginTop: "14px" }}>
        {autonomousProof.landedPayments[0] && (
          <ProofItem label="Real payment transaction" value={autonomousProof.landedPayments[0].signature} isTx />
        )}
        <div className="proof-item">
          <div className="proof-label">Vendor's decrypted balance matches what the run reported</div>
          <div className="proof-verdict">
            {autonomousProof.phase1.verifiedAgainstOnChainBalance ? "yes, verified" : "MISMATCH"}
          </div>
        </div>
      </div>

      <div className="step-head" style={{ marginTop: "2.5rem" }}>
        <h3>Then it was asked to pay more than its budget allowed.</h3>
        <p className="section-sub">
          The second goal deliberately exceeds the remaining period limit, however the payment is
          split. The agent tried anyway — the log below is unedited, including every repeated
          attempt.
        </p>
      </div>

      <div className="proof-item" style={{ marginBottom: "1rem" }}>
        <div className="proof-label">Goal given to the agent</div>
        <div className="proof-verdict" style={{ fontSize: "0.85rem", fontWeight: 400 }}>
          {autonomousProof.phase2.goal}
        </div>
      </div>
      <AutonomousConsole steps={autonomousProof.phase2.steps as AutonomousStep[]} />

      <div className="proof-grid" style={{ marginTop: "14px" }}>
        <div className="proof-item">
          <div className="proof-label">Amount requested vs. actually paid</div>
          <div className="proof-verdict">
            {formatTokens(autonomousProof.phase2.amountRequested)} requested,{" "}
            {formatTokens(autonomousProof.phase2.amountActuallyPaid)} paid
          </div>
        </div>
        <div className="proof-item">
          <div className="proof-label">Period total vs. limit</div>
          <div className="proof-verdict">
            {formatTokens(autonomousProof.phase2.periodTotalAfter)} of {formatTokens(autonomousProof.phase2.periodLimit)}
          </div>
        </div>
        <div className="proof-item">
          <div className="proof-label">Refused attempts</div>
          <div className="proof-verdict">{autonomousProof.phase2.refusalCount}</div>
        </div>
        <div className="proof-item">
          <div className="proof-label">Vendor's decrypted balance matches what the run reported</div>
          <div className="proof-verdict">
            {autonomousProof.phase2.verifiedAgainstOnChainBalance ? "yes, verified" : "MISMATCH"}
          </div>
        </div>
      </div>

      <div className="proof-item" style={{ marginTop: "14px" }}>
        <div className="proof-label">The agent&apos;s own closing summary — not proof by itself</div>
        <div className="proof-verdict" style={{ fontSize: "0.85rem", fontWeight: 400 }}>
          {autonomousProof.phase2.modelSummary.trim().length > 0
            ? autonomousProof.phase2.modelSummary
            : "(empty — this particular run spent all its steps retrying the refused request and never " +
              "produced a closing summary at all. Which is exactly the point: the numbers above come " +
              "from decrypting the vendor's real balance, not from asking the model what happened.)"}
        </div>
      </div>

      <div className="step-head" style={{ marginTop: "2.5rem" }}>
        <h3>And the limit is no longer something the agent could route around.</h3>
        <p className="section-sub">
          Token-2022 refuses delegate authority outright, so the only way to bind the limit was to
          give the program the account itself. Which raises the obvious question: what stops it, or
          the agent, from keeping it?
        </p>
      </div>

      <div className="proof-grid">
        <ProofItem label="Custody handover" value={custodyProof.signatures.assumeCustody} isTx />
        <ProofItem
          label="Confidential transfer, signed by the program"
          value={custodyProof.signatures.confidentialTransfer}
          isTx
        />
        <ProofItem label="Owner takes it back" value={custodyProof.signatures.releaseCustody} isTx />
        <ProofItem label="Custodied account" value={custodyProof.custodiedTokenAccount} />
      </div>

      <CustodyChecklist checks={custodyProof.checks as CustodyCheck[]} />

      <div className="step-head" style={{ marginTop: "2.5rem" }}>
        <h3>Even the limit itself is no longer a public number.</h3>
        <p className="section-sub">
          The program subtracts the encrypted amount from the encrypted limit and requires a proof
          the result is not negative. An over-budget spend has no such proof to give.
        </p>
      </div>

      <div className="proof-grid">
        <ProofItem label="Policy account" value={confidentialLimitsProof.policyAccount} />
        <ProofItem label="Authorization transaction" value={confidentialLimitsProof.authorizeSignature} isTx />
        <div className="proof-item">
          <div className="proof-label">Limit values stored on-chain</div>
          <div className="proof-verdict">encrypted, never in the clear</div>
        </div>
      </div>

      <CustodyChecklist checks={confidentialLimitsProof.checks as CustodyCheck[]} />

      <div className="proof-item" style={{ marginTop: "14px" }}>
        <div className="proof-label">What this does not claim</div>
        <div className="proof-verdict" style={{ fontSize: "0.85rem", fontWeight: 400 }}>
          Hidden from the public, not from the agent — proving requires the key. And none of this
          is untraceable: addresses, mint and timing stay visible. Hidden is the amount, the
          reasoning, and the budget.
        </div>
      </div>
    </div>
  );
}

function ProofStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <div className="encryption-proof-step">
      <span className="encryption-proof-number">{number}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function PrivacyBoundaryItem({
  label,
  technology,
  isPrivate,
}: {
  label: string;
  technology: string;
  isPrivate: boolean;
}) {
  return (
    <div className="privacy-boundary-item">
      <span className={`privacy-boundary-state ${isPrivate ? "is-private" : "is-public"}`}>
        {isPrivate ? "Encrypted" : "Public"}
      </span>
      <div>
        <strong>{label}</strong>
        <span>{technology}</span>
      </div>
    </div>
  );
}

/**
 * Renders the live-devnet checks verbatim, expected value beside observed —
 * the point being that each row is a comparison anyone can redo, not a claim
 * to be taken on trust.
 */
function CustodyChecklist({ checks }: { checks: readonly CustodyCheck[] }) {
  const passed = checks.filter((check) => check.ok).length;
  return (
    <section className="card console" style={{ position: "static", marginTop: "14px" }}>
      <div className="console-head">
        <span className="dot" />
        Live devnet checks ({passed}/{checks.length} passed)
      </div>
      <div className="console-body" style={{ maxHeight: "480px" }}>
        {checks.map((check, i) => (
          <div className={`step step-${check.ok ? "execute" : "refused"}`} key={i}>
            <span className="step-kind">{check.ok ? "holds" : "failed"}</span>
            <span className="step-text">
              {check.step}
              <br />
              <span style={{ opacity: 0.62 }}>observed: {check.observed}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Collapses runs of identical consecutive steps (a model retrying the same refused call) into one row with a count, rather than rendering each attempt separately. */
function groupConsecutiveSteps(steps: readonly AutonomousStep[]) {
  const groups: { step: AutonomousStep; count: number }[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.step.tool === step.tool && last.step.outcome === step.outcome && last.step.reason === step.reason) {
      last.count += 1;
    } else {
      groups.push({ step, count: 1 });
    }
  }
  return groups;
}

function formatTokens(baseUnits: string): string {
  return (Number(baseUnits) / 1_000_000).toString();
}

function AutonomousConsole({ steps }: { steps: readonly AutonomousStep[] }) {
  const groups = groupConsecutiveSteps(steps);
  return (
    <section className="card console" style={{ position: "static" }}>
      <div className="console-head">
        <span className="dot" />
        Agent tool calls ({steps.length} total)
      </div>
      <div className="console-body" style={{ maxHeight: "420px" }}>
        {groups.map((group, i) => (
          <div className={`step step-${group.step.outcome === "allowed" ? "execute" : "refused"}`} key={i}>
            <span className="step-kind">{group.step.outcome === "allowed" ? "runs" : "blocked"}</span>
            <span className="step-text">
              {group.step.tool}
              {group.step.reason ? ` — ${group.step.reason}` : ""}
              {group.count > 1 ? ` (×${group.count})` : ""}
            </span>
          </div>
        ))}
      </div>
    </section>
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
