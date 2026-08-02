import { generateKeyPairSigner } from "@solana/kit";
import { buildProvisionPolicyAccountInstructions } from "../data/policy-program";
import { sendInstructionsWithSigner } from "../data/solana-client";
import type { SolanaClient } from "../data/solana-client";
import { getOwnerTransactionSigner } from "./wallet-connection";
import { toPolicyInitParams } from "./agent-setup";
import type { AgentDraftDTO } from "../dto/agent.dto";
import type { WalletConnectionDTO } from "../dto/wallet.dto";

/**
 * Turns an onboarding draft into a real on-chain policy account, signed by
 * the connected owner wallet. This is the one part of onboarding that
 * actually touches devnet — everything before it (draft, policy preview) is
 * local until this call succeeds.
 *
 * Known Stage-1 gap, deliberate rather than overlooked: the agent keypair
 * generated here is ephemeral and its secret is discarded after this call —
 * only its public address is written into the policy account. Persisting an
 * agent signer for a live `authorize` call during a run is blocked on the
 * key-custody decision PRODUCT_EXPERIENCE.md (open decision #2) and
 * PRIVACY_ARCHITECTURE.md (open decision #2) both leave open; deciding it
 * silently here would be exactly what those documents say not to do.
 */

export interface ProvisionAgentPolicyParams {
  readonly client: SolanaClient;
  readonly ownerWallet: WalletConnectionDTO;
  readonly draft: AgentDraftDTO;
}

export interface ProvisionAgentPolicyResultDTO {
  readonly policyAccount: string;
  readonly agentAddress: string;
  readonly signature: string;
}

export async function provisionAgentPolicy(
  params: ProvisionAgentPolicyParams,
): Promise<ProvisionAgentPolicyResultDTO> {
  const policyAccountSigner = await generateKeyPairSigner();
  const agentSigner = await generateKeyPairSigner();
  const ownerSigner = getOwnerTransactionSigner(params.ownerWallet);
  const policy = toPolicyInitParams(params.draft);

  const instructions = await buildProvisionPolicyAccountInstructions(params.client, {
    policyAccount: policyAccountSigner,
    owner: ownerSigner,
    agent: agentSigner.address,
    maxPerTransfer: policy.maxPerTransfer,
    maxPerPeriod: policy.maxPerPeriod,
    periodSeconds: policy.periodSeconds,
  });

  const signature = await sendInstructionsWithSigner(params.client, ownerSigner, instructions);

  return {
    policyAccount: policyAccountSigner.address,
    agentAddress: agentSigner.address,
    signature,
  };
}
