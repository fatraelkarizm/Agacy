"use client";

import { useState } from "react";
import {
  PURPOSE_PRESETS,
  toPolicyInitParams,
  validateAgentDraft,
  type AgentDraftDTO,
  type AgentPurpose,
} from "../server/services/agent-setup";

const PURPOSE_LABELS: Record<AgentPurpose, { title: string; blurb: string }> = {
  subscriptions: { title: "Subscriptions", blurb: "Recurring services and renewals" },
  trading: { title: "Trading", blurb: "Frequent, higher-value moves" },
  procurement: { title: "Procurement", blurb: "Business purchases and suppliers" },
  custom: { title: "Custom", blurb: "Set every limit yourself" },
};

export interface AgentSetupProps {
  readonly onCreate: (draft: AgentDraftDTO) => void;
}

export function AgentSetup({ onCreate }: AgentSetupProps) {
  const [draft, setDraft] = useState<AgentDraftDTO>({
    name: "Ops agent",
    purpose: "subscriptions",
    ...PURPOSE_PRESETS.subscriptions,
  });

  const issues = validateAgentDraft(draft);
  const set = <K extends keyof AgentDraftDTO>(key: K, value: AgentDraftDTO[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const choosePurpose = (purpose: AgentPurpose) =>
    setDraft((prev) => ({ ...prev, purpose, ...PURPOSE_PRESETS[purpose] }));

  const issueFor = (field: keyof AgentDraftDTO) =>
    issues.find((issue) => issue.field === field)?.message;

  return (
    <section className="card setup">
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

      <div className="field-grid">
        <Field label="Agent name" error={issueFor("name")}>
          <input value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </Field>

        <Field label="Max per transfer (USDC)" error={issueFor("maxPerTransfer")}>
          <input
            type="number"
            min={0}
            value={draft.maxPerTransfer}
            onChange={(e) => set("maxPerTransfer", Number(e.target.value))}
          />
        </Field>

        <Field label="Max per period (USDC)" error={issueFor("maxPerPeriod")}>
          <input
            type="number"
            min={0}
            value={draft.maxPerPeriod}
            onChange={(e) => set("maxPerPeriod", Number(e.target.value))}
          />
        </Field>

        <Field label="Period length (days)" error={issueFor("periodDays")}>
          <input
            type="number"
            min={1}
            value={draft.periodDays}
            onChange={(e) => set("periodDays", Number(e.target.value))}
          />
        </Field>
      </div>

      <div className="visibility">
        <div className="explorer-label">Visibility</div>
        <div className="visibility-options">
          <VisibilityOption
            selected={draft.visibility === "confidential"}
            onClick={() => set("visibility", "confidential")}
            title="Confidential"
            blurb="Amounts encrypted on-chain. Only you can read them."
            recommended
          />
          <VisibilityOption
            selected={draft.visibility === "public"}
            onClick={() => set("visibility", "public")}
            title="Public"
            blurb="Everything readable by anyone. For agents meant to be audited in the open."
          />
        </div>
      </div>

      <div className="step-footer">
        <button className="primary" disabled={issues.length > 0} onClick={() => onCreate(draft)}>
          Create agent →
        </button>
        {issues.length === 0 && <PolicyPreview draft={draft} />}
      </div>
    </section>
  );
}

function PolicyPreview({ draft }: { draft: AgentDraftDTO }) {
  const params = toPolicyInitParams(draft);
  return (
    <p className="hint">
      Stored on-chain as {params.maxPerTransfer.toString()} / {params.maxPerPeriod.toString()} base
      units over {params.periodSeconds.toString()}s
      {params.allowNonConfidentialCredits ? " · public credits allowed" : " · confidential only"}
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
