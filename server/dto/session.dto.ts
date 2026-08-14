import type { AgentDraftDTO, AgentExecutionDTO, AgentOnboardingStep, SpendPolicyDTO } from "./agent.dto";
import type { DashboardSection } from "./dashboard.dto";
import type { RealTreasuryDTO, VendorPaymentProfileDTO } from "./real-payment.dto";

/**
 * What survives a page refresh while the owner stays on the same wallet.
 *
 * Scoped to `ownerAddress` rather than being a single global blob: restoring
 * this under a different connected wallet would hand one owner's draft/agent
 * to another, which is exactly the kind of cross-session leak the DTO
 * boundary elsewhere in this app exists to prevent.
 *
 * This is explicitly a *temporary* client-side convenience, not the source of
 * truth. Once provisioning writes the agent/policy to devnet, the dashboard
 * should reload from chain state; this DTO only bridges the gap until that
 * exists (see docs/PRODUCT_EXPERIENCE.md open decision #4).
 */
/** On-chain addresses from a successful `provisionAgentPolicy` call — see server/services/agent-provisioning.ts. */
export interface ProvisionedPolicyDTO {
  readonly policyAccount: string;
  readonly agentAddress: string;
  readonly signature: string;
}

export interface DashboardSessionDTO {
  readonly ownerAddress: string;
  readonly dashboardSection: DashboardSection;
  readonly onboardingStep: AgentOnboardingStep;
  readonly setupDraft: AgentDraftDTO;
  readonly agent: AgentDraftDTO | null;
  readonly policy: SpendPolicyDTO | null;
  readonly executed: readonly AgentExecutionDTO[];
  readonly provisionedPolicy: ProvisionedPolicyDTO | null;
  /** Public on-chain references only. Confidential keys and the agent signer stay memory-only. */
  readonly realTreasury: RealTreasuryDTO | null;
  readonly vendorProfile: VendorPaymentProfileDTO | null;
}
