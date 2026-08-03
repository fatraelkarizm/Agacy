import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
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
 * The agent keypair generated here is returned to the caller and kept for the
 * browser session only — never stored, never transmitted. That is what lets the
 * run sign a real `authorize` against this account instead of deciding locally
 * and claiming it had. How a long-lived agent should hold a key is still the
 * open question PRODUCT_EXPERIENCE.md (decision #2) and PRIVACY_ARCHITECTURE.md
 * (decision #2) describe, and a key that dies with the tab deliberately answers
 * none of it.
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
  /**
   * The agent's signer, held for the lifetime of the browser session and
   * nothing longer — never written to storage, never sent anywhere. Without it
   * the agent cannot sign `authorize`, and the run could only ever pretend to
   * enforce a limit; with it, the enforcement is the chain's.
   *
   * This is the narrowest form of the key-custody question PRODUCT_EXPERIENCE.md
   * (open decision #2) leaves open, and it is answered narrowly on purpose:
   * a key that dies with the tab commits to nothing about how a long-lived
   * agent should hold one.
   */
  readonly agentSigner: KeyPairSigner;
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
    agentSigner,
  };
}
