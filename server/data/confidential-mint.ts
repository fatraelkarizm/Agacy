import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
  some,
  none,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
} from "@solana-program/token-2022";
import type { SolanaClient } from "./solana-client.js";

/**
 * Creating a mint that supports confidential transfers.
 *
 * Order matters and is enforced by the program: the confidential-transfer
 * extension has to be initialized *before* `InitializeMint2`, because
 * initializing the mint finalizes its extension set. Doing it the other way
 * round fails at runtime with an unhelpful error, so the sequence below is
 * deliberate rather than incidental.
 */

export interface ConfidentialMintConfig {
  readonly decimals: number;
  /** Authority allowed to update confidential-transfer settings later. */
  readonly authority: Address;
  /**
   * When true, accounts can start using confidential transfers immediately.
   * When false, each account must be approved by the mint authority first.
   */
  readonly autoApproveNewAccounts: boolean;
  /**
   * Optional auditor key that can decrypt every transfer amount for this mint.
   * The program encodes ElGamal pubkeys in the same 32-byte base58 form as an
   * address, hence the Address type here.
   *
   * Left unset for Agacy: an auditor able to read every amount would undercut
   * the confidentiality the product exists to provide.
   */
  readonly auditorElGamalPubkey?: Address;
}

export interface CreatedMint {
  readonly mint: Address;
  readonly signature: string;
}

export async function createConfidentialMint(
  client: SolanaClient,
  payer: KeyPairSigner,
  config: ConfidentialMintConfig,
): Promise<CreatedMint> {
  const mintSigner = await generateKeyPairSigner();
  const auditor = config.auditorElGamalPubkey ? some(config.auditorElGamalPubkey) : none<Address>();

  // getMintSize encodes the extension to measure it, so every field has to be
  // present here — a partial object fails inside the codec, not with a type error.
  const space = BigInt(
    getMintSize([
      {
        __kind: "ConfidentialTransferMint",
        authority: some(config.authority),
        autoApproveNewAccounts: config.autoApproveNewAccounts,
        auditorElgamalPubkey: auditor,
      },
    ]),
  );
  const rent = await client.rpc.getMinimumBalanceForRentExemption(space).send();

  const instructions = [
    getCreateAccountInstruction({
      payer,
      newAccount: mintSigner,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeConfidentialTransferMintInstruction({
      mint: mintSigner.address,
      authority: config.authority,
      autoApproveNewAccounts: config.autoApproveNewAccounts,
      auditorElgamalPubkey: auditor,
    }),
    getInitializeMint2Instruction({
      mint: mintSigner.address,
      decimals: config.decimals,
      mintAuthority: payer.address,
      freezeAuthority: null,
    }),
  ];

  const signature = await sendInstructions(client, payer, instructions);
  return { mint: mintSigner.address, signature };
}

/**
 * Shared transaction plumbing: build, sign, send, confirm.
 *
 * A confidential transfer needs several transactions back to back (three proof
 * verifications, the transfer, then cleanup), which trips the public devnet
 * RPC's rate limiter. Retrying on 429 keeps a correct flow from looking like a
 * failure just because it was too fast for a free endpoint.
 */
export async function sendInstructions(
  client: SolanaClient,
  payer: KeyPairSigner,
  instructions: readonly unknown[],
  attempts = 5,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sendOnce(client, payer, instructions);
    } catch (error) {
      lastError = error;
      // Only a rate-limited *send* is safe to retry. Anything else may have
      // already landed on-chain, and re-sending it would fail confusingly
      // (e.g. "account already initialized") while hiding the real error.
      if (!isRateLimited(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
    }
  }

  throw lastError;
}

function isRateLimited(error: unknown): boolean {
  return String((error as Error)?.message ?? error).includes("429");
}

async function sendOnce(
  client: SolanaClient,
  payer: KeyPairSigner,
  instructions: readonly unknown[],
): Promise<string> {
  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions as never, m),
  );

  const signed = await signTransactionMessageWithSigners(message);
  const sendAndConfirm = sendAndConfirmTransactionFactory(client);
  // The message is built with a blockhash lifetime above, but the signed type
  // widens to "blockhash or durable nonce"; narrow it back for the sender.
  await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
    commitment: "confirmed",
  });
  return getSignatureFromTransaction(signed);
}

export { ExtensionType };
