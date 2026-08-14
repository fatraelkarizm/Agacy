import {
  generateKeyPairSigner,
  type Address,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeAccount3Instruction,
  getConfigureConfidentialTransferAccountInstruction,
  getTokenSize,
  type ExtensionArgs,
} from "@solana-program/token-2022";
import { PubkeyValidityProofData } from "@solana/zk-sdk/node";
import { verifyPubkeyValidity } from "@solana-program/zk-elgamal-proof";
import type { SolanaClient } from "./solana-client.js";
import { sendInstructionsWithSigner } from "./solana-client.js";
import { sendInstructions } from "./confidential-mint.js";
import type { ConfidentialKeys } from "./confidential-keys.js";

/**
 * Creating and configuring a token account for confidential transfers.
 *
 * Configuration is the step that binds the owner's ElGamal key to the account,
 * and the program will not take that key on trust: it requires a pubkey
 * validity proof showing the caller actually holds the matching secret. That
 * proof is verified by the ZK ElGamal Proof program in the same transaction,
 * which is why the two instructions ship together and why the configure
 * instruction carries an offset pointing back at the verification instruction.
 */

/** Instruction offset is relative: +1 means "the next instruction in this transaction". */
const PROOF_INSTRUCTION_OFFSET = 1;

/**
 * `getTokenSize` measures an extension by encoding it, so it needs a fully
 * populated object even when we only want the byte count. The values below are
 * placeholders — the extension's size is fixed, so none of them affect the
 * result. Kept in one place so the real account-creation path stays readable.
 */
function confidentialAccountSizingTemplate(): ExtensionArgs {
  const zeros = (length: number) => new Uint8Array(length);
  const PLACEHOLDER_KEY = "11111111111111111111111111111111" as Address;

  return {
    __kind: "ConfidentialTransferAccount",
    approved: true,
    elgamalPubkey: PLACEHOLDER_KEY,
    pendingBalanceLow: zeros(64) as never,
    pendingBalanceHigh: zeros(64) as never,
    availableBalance: zeros(64) as never,
    decryptableAvailableBalance: zeros(36) as never,
    allowConfidentialCredits: true,
    allowNonConfidentialCredits: true,
    pendingBalanceCreditCounter: 0n,
    maximumPendingBalanceCreditCounter: 0n,
    expectedPendingBalanceCreditCounter: 0n,
    actualPendingBalanceCreditCounter: 0n,
  };
}

/** How many pending incoming transfers can accumulate before the owner must apply them. */
const DEFAULT_MAX_PENDING_CREDITS = 65_536n;

export interface ConfidentialAccountSetup {
  readonly tokenAccount: Address;
  readonly signature: string;
}

export async function createConfidentialTokenAccount(
  client: SolanaClient,
  payer: KeyPairSigner,
  owner: KeyPairSigner,
  mint: Address,
  keys: ConfidentialKeys,
): Promise<ConfidentialAccountSetup> {
  const tokenSigner = await generateKeyPairSigner();
  const space = BigInt(getTokenSize([confidentialAccountSizingTemplate()]));
  const rent = await client.rpc.getMinimumBalanceForRentExemption(space).send();

  // A freshly configured account holds zero, but the program still needs that
  // zero encrypted under the owner's key so every later balance update is
  // homomorphic against a real ciphertext rather than a special-cased empty value.
  const decryptableZeroBalance = keys.ae.encrypt(0n).toBytes();

  const validityProof = new PubkeyValidityProofData(keys.elGamal);
  const proofInstructions = await verifyPubkeyValidity({
    rpc: client.rpc,
    payer,
    proofData: validityProof.toBytes(),
  });

  const signature = await sendInstructions(client, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: tokenSigner,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccount3Instruction({
      account: tokenSigner.address,
      mint,
      owner: owner.address,
    }),
    getConfigureConfidentialTransferAccountInstruction({
      token: tokenSigner.address,
      mint,
      authority: owner,
      decryptableZeroBalance: decryptableZeroBalance as never,
      maximumPendingBalanceCreditCounter: DEFAULT_MAX_PENDING_CREDITS,
      proofInstructionOffset: PROOF_INSTRUCTION_OFFSET,
    }),
    ...proofInstructions,
  ]);

  return { tokenAccount: tokenSigner.address, signature };
}

export async function createConfidentialTokenAccountWithSigner(
  client: SolanaClient,
  payer: TransactionSigner,
  owner: TransactionSigner,
  mint: Address,
  keys: ConfidentialKeys,
): Promise<ConfidentialAccountSetup> {
  const tokenSigner = await generateKeyPairSigner();
  const space = BigInt(getTokenSize([confidentialAccountSizingTemplate()]));
  const rent = await client.rpc.getMinimumBalanceForRentExemption(space).send();
  const validityProof = new PubkeyValidityProofData(keys.elGamal);
  const proofInstructions = await verifyPubkeyValidity({
    rpc: client.rpc,
    payer,
    proofData: validityProof.toBytes(),
  });

  const signature = await sendInstructionsWithSigner(client, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: tokenSigner,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccount3Instruction({ account: tokenSigner.address, mint, owner: owner.address }),
    getConfigureConfidentialTransferAccountInstruction({
      token: tokenSigner.address,
      mint,
      authority: owner,
      decryptableZeroBalance: keys.ae.encrypt(0n).toBytes() as never,
      maximumPendingBalanceCreditCounter: DEFAULT_MAX_PENDING_CREDITS,
      proofInstructionOffset: PROOF_INSTRUCTION_OFFSET,
    }),
    ...proofInstructions,
  ]);
  return { tokenAccount: tokenSigner.address, signature };
}
