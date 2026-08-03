import { generateKeyPairSigner } from "@solana/kit";
import {
  buildInitializePolicyV2Instruction,
  derivePolicyAddress,
  POLICY_V2_PROGRAM_ID,
} from "../data/policy-program-v2";
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
 * Targets `agacy_policy_v2` rather than the original native program, and the
 * difference is not cosmetic: a v2 policy account is a PDA the program can
 * sign for, which is what lets the limit be *enforced* by custody rather than
 * merely recorded alongside a spend. Provisioning through the native program
 * produced an account that could only ever observe a payment. See
 * docs/PRIVACY_ARCHITECTURE.md §14.
 *
 * Two consequences worth knowing at the call site:
 *
 * - No separate account keypair is generated or funded. The address is
 *   derived from `[b"policy", owner, agent]`, so the same owner/agent pair
 *   always resolves to the same account rather than quietly creating a second
 *   one.
 * - It is a single instruction. Anchor's `init` allocates and writes in the
 *   same call, so there is no created-but-uninitialized intermediate state for
 *   anything to observe.
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
  readonly programId: string;
}

export async function provisionAgentPolicy(
  params: ProvisionAgentPolicyParams,
): Promise<ProvisionAgentPolicyResultDTO> {
  const agentSigner = await generateKeyPairSigner();
  const ownerSigner = getOwnerTransactionSigner(params.ownerWallet);
  const policy = toPolicyInitParams(params.draft);

  const policyAccount = await derivePolicyAddress(ownerSigner.address, agentSigner.address);

  const instruction = buildInitializePolicyV2Instruction({
    policyAccount,
    owner: ownerSigner,
    agent: agentSigner.address,
    maxPerTransfer: policy.maxPerTransfer,
    maxPerPeriod: policy.maxPerPeriod,
    periodSeconds: policy.periodSeconds,
  });

  const signature = await sendInstructionsWithSigner(params.client, ownerSigner, [instruction]);

  return {
    policyAccount,
    agentAddress: agentSigner.address,
    signature,
    programId: POLICY_V2_PROGRAM_ID,
  };
}
