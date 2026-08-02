"use client";

import { Broadcast, Info, ShieldCheck, Wallet } from "@phosphor-icons/react";
import {
  PURPOSE_PRESETS,
  toPolicyInitParams,
  validateAgentDraft,
} from "../server/services/agent-setup";
import type {
  AgentDraftDTO,
  AgentOnboardingStep,
  AgentPurpose,
} from "../server/dto/agent.dto";
import type { WalletConnectionDTO } from "../server/dto/wallet.dto";

const PURPOSE_LABELS: Record<AgentPurpose, { title: string; blurb: string }> = {
  subscriptions: { title: "Subscriptions", blurb: "Recurring services and renewals" },
  trading: { title: "Trading", blurb: "Frequent, higher-value moves" },
  procurement: { title: "Procurement", blurb: "Business purchases and suppliers" },
  custom: { title: "Custom", blurb: "Set every limit yourself" },
};

const ONBOARDING_STEPS: readonly { id: AgentOnboardingStep; label: string }[] = [
  { id: "define", label: "Define agent" },
  { id: "policy", label: "Spending policy" },
  { id: "privacy", label: "Privacy & access" },
  { id: "review", label: "Review" },
];

const POLICY_FIELDS: readonly (keyof AgentDraftDTO)[] = [
  "maxPerTransfer",
  "maxPerPeriod",
  "periodDays",
];

interface AgentSetupProps {
  readonly draft: AgentDraftDTO;
  readonly ownerWallet: WalletConnectionDTO;
  readonly step: AgentOnboardingStep;
  readonly onDraftChange: (draft: AgentDraftDTO) => void;
  readonly onStepChange: (step: AgentOnboardingStep) => void;
  readonly onCreate: (draft: AgentDraftDTO) => void;
}

export function AgentSetup({
  draft,
  ownerWallet,
  step,
  onDraftChange,
  onStepChange,
  onCreate,
}: AgentSetupProps) {
  const issues = validateAgentDraft(draft);
  const stepIndex = ONBOARDING_STEPS.findIndex(({ id }) => id === step);
  const set = <K extends keyof AgentDraftDTO>(key: K, value: AgentDraftDTO[K]) =>
    onDraftChange({ ...draft, [key]: value });

  const choosePurpose = (purpose: AgentPurpose) =>
    onDraftChange({ ...draft, purpose, ...PURPOSE_PRESETS[purpose] });

  const issueFor = (field: keyof AgentDraftDTO) =>
    issues.find((issue) => issue.field === field)?.message;

  const defineValid = !issueFor("name");
  const policyValid = !issues.some(({ field }) => POLICY_FIELDS.includes(field));
  const stepAvailable = (target: number) =>
    target === 0 || (target === 1 && defineValid) || (target > 1 && defineValid && policyValid);

  const next = () => {
    const nextStep = ONBOARDING_STEPS[stepIndex + 1];
    if (nextStep) onStepChange(nextStep.id);
  };

  const back = () => {
    const previousStep = ONBOARDING_STEPS[stepIndex - 1];
    if (previousStep) onStepChange(previousStep.id);
  };

  return (
    <section className="card setup onboarding-shell">
      <nav className="onboarding-progress" aria-label="Agent onboarding progress">
        {ONBOARDING_STEPS.map((item, index) => (
          <button
            key={item.id}
            className={item.id === step ? "active" : index < stepIndex ? "complete" : ""}
            disabled={!stepAvailable(index)}
            onClick={() => onStepChange(item.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="onboarding-content-grid">
        <div className="onboarding-main">
          <div className="onboarding-body">
        {step === "define" && (
          <div className="onboarding-panel">
            <PanelHeading
              title="What should this agent do?"
              description="Choose a purpose, then give the agent a name you will recognize in the owner dashboard."
            />
            <div className="purpose-grid">
              {(Object.keys(PURPOSE_LABELS) as AgentPurpose[]).map((purpose) => (
                <button
                  key={purpose}
                  className={draft.purpose === purpose ? "purpose selected" : "purpose"}
                  onClick={() => choosePurpose(purpose)}
                >
                  <span className="purpose-title">{PURPOSE_LABELS[purpose].title}</span>
                  <span className="purpose-blurb">{PURPOSE_LABELS[purpose].blurb}</span>
                </button>
              ))}
            </div>
            <div className="field-grid single-field">
              <Field label="Agent name" error={issueFor("name")}>
                <input value={draft.name} onChange={(event) => set("name", event.target.value)} />
              </Field>
            </div>
          </div>
        )}

        {step === "policy" && (
          <div className="onboarding-panel">
            <PanelHeading
              title="Set the hard spending boundary."
              description="These limits are checked outside the model before an agent action can execute."
            />
            <div className="field-grid policy-fields">
              <Field label="Max per transfer (USDC)" error={issueFor("maxPerTransfer")}>
                <input
                  type="number"
                  min={0}
                  value={draft.maxPerTransfer}
                  onChange={(event) => set("maxPerTransfer", Number(event.target.value))}
                />
              </Field>
              <Field label="Max per period (USDC)" error={issueFor("maxPerPeriod")}>
                <input
                  type="number"
                  min={0}
                  value={draft.maxPerPeriod}
                  onChange={(event) => set("maxPerPeriod", Number(event.target.value))}
                />
              </Field>
              <Field label="Period length (days)" error={issueFor("periodDays")}>
                <input
                  type="number"
                  min={1}
                  value={draft.periodDays}
                  onChange={(event) => set("periodDays", Number(event.target.value))}
                />
              </Field>
            </div>
            <p className="policy-boundary-note">
              The agent can propose a larger payment. The policy path is responsible for rejecting
              it before funds move.
            </p>
          </div>
        )}

        {step === "privacy" && (
          <div className="onboarding-panel">
            <PanelHeading
              title="Choose what observers can learn."
              description="Owner access and public data stay structurally separate throughout the app."
            />
            <div className="visibility-options">
              <VisibilityOption
                selected={draft.visibility === "confidential"}
                onClick={() => set("visibility", "confidential")}
                title="Confidential"
                blurb="Amounts and balances encrypted. Owner-authorized detail only."
                recommended
              />
              <VisibilityOption
                selected={draft.visibility === "public"}
                onClick={() => set("visibility", "public")}
                title="Public"
                blurb="Readable by anyone. For intentionally transparent agents."
              />
            </div>
            <p className="privacy-scope-note">
              Current devnet mode hides amounts and balances. Address unlinkability belongs to the
              planned shielded execution layer and is not claimed here.
            </p>
          </div>
        )}

        {step === "review" && (
          <div className="onboarding-panel">
            <PanelHeading
              title="Review before the owner signs."
              description="Connecting proves ownership. Agent authority is created as a separate action."
            />
            <dl className="review-grid">
              <ReviewItem label="Owner" value={shortAddress(ownerWallet.address)} />
              <ReviewItem label="Network" value={ownerWallet.network} />
              <ReviewItem label="Agent" value={draft.name} />
              <ReviewItem label="Purpose" value={PURPOSE_LABELS[draft.purpose].title} />
              <ReviewItem label="Per transfer" value={`${draft.maxPerTransfer} USDC`} />
              <ReviewItem label="Per period" value={`${draft.maxPerPeriod} USDC / ${draft.periodDays}d`} />
              <ReviewItem label="Visibility" value={draft.visibility} />
              <ReviewItem label="Authority" value="Scoped agent permission" />
            </dl>
            <PolicyPreview draft={draft} />
          </div>
        )}
          </div>

          <div className="step-footer onboarding-actions">
            <button onClick={back} disabled={stepIndex === 0}>
              Back
            </button>
            <span className="hint">
              Step {stepIndex + 1} of {ONBOARDING_STEPS.length}
            </span>
            {step !== "review" ? (
              <button
                className="primary"
                disabled={(step === "define" && !defineValid) || (step === "policy" && !policyValid)}
                onClick={next}
              >
                Continue
              </button>
            ) : (
              <button className="primary" disabled={issues.length > 0} onClick={() => onCreate(draft)}>
                Create agent
              </button>
            )}
          </div>
        </div>

        <aside className="onboarding-owner-rail">
          <header>
            <ShieldCheck aria-hidden="true" size={26} weight="duotone" />
            <h3>Owner authority</h3>
          </header>
          <p className="dashboard-label">Connected wallet</p>
          <div className="onboarding-owner-value">
            <Wallet aria-hidden="true" size={18} weight="duotone" />
            <code>{shortAddress(ownerWallet.address)}</code>
          </div>
          <p className="dashboard-label">Network</p>
          <div className="onboarding-owner-network">
            <Broadcast aria-hidden="true" size={18} weight="duotone" />
            <span>{ownerWallet.network}</span>
          </div>
          <div className="onboarding-owner-note">
            <Info aria-hidden="true" size={19} weight="duotone" />
            <p>
              Connecting proves ownership. It does not give the agent permission to spend. The
              next steps define that scope.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function PanelHeading({ title, description }: { title: string; description: string }) {
  return (
    <header className="onboarding-panel-head">
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PolicyPreview({ draft }: { draft: AgentDraftDTO }) {
  const params = toPolicyInitParams(draft);
  return (
    <p className="hint review-encoding">
      On-chain encoding: {params.maxPerTransfer.toString()} / {params.maxPerPeriod.toString()} base
      units over {params.periodSeconds.toString()}s
      {params.allowNonConfidentialCredits ? " | public credits allowed" : " | confidential only"}
    </p>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function VisibilityOption({
  selected,
  onClick,
  title,
  blurb,
  recommended,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  blurb: string;
  recommended?: boolean;
}) {
  return (
    <button className={selected ? "vis-option selected" : "vis-option"} onClick={onClick}>
      <span className="vis-title">
        {title}
        {recommended && <span className="vis-badge">default</span>}
      </span>
      <span className="vis-blurb">{blurb}</span>
    </button>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
