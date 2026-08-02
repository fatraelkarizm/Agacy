import {
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  signatureBytes,
  type Address,
  type SignatureBytes,
  type Transaction as KitTransaction,
  type TransactionSendingSigner,
} from "@solana/kit";
import { VersionedTransaction } from "@solana/web3.js";
import type { WalletProviderId } from "../dto/wallet.dto";
import { signAndSendWithInjectedWallet } from "./wallet-provider";

/**
 * Bridges a browser wallet extension into `@solana/kit`'s signer model.
 *
 * Every instruction builder in this codebase (`policy-program.ts`,
 * `confidential-*.ts`) produces `@solana/kit` transactions. Phantom and
 * Solflare's legacy injected `signAndSendTransaction` expects a
 * `@solana/web3.js` `VersionedTransaction` instead — the two are not
 * interchangeable, so this module exists solely to convert one into the
 * other. `@solana/web3.js` is intentionally not used anywhere else in this
 * codebase; it is scoped to this one conversion.
 *
 * NOT YET VERIFIED against a real Phantom/Solflare extension — there is no
 * browser available in the environment this was written in. Before trusting
 * this in a live demo, connect a real wallet and confirm a `TransactionSendingSigner`
 * built here can actually complete `buildProvisionPolicyAccountInstructions`
 * end-to-end on devnet. See docs/INFRASTRUCTURE.md "Open Implementation
 * Questions" for the reasoning behind this specific bridge design.
 */
export function createWalletTransactionSigner(
  address: Address,
  providerId: WalletProviderId,
): TransactionSendingSigner {
  return {
    address,
    async signAndSendTransactions(transactions: readonly KitTransaction[]) {
      const signatures: SignatureBytes[] = [];
      for (const transaction of transactions) {
        signatures.push(await signAndSendOne(providerId, transaction));
      }
      return signatures;
    },
  };
}

async function signAndSendOne(
  providerId: WalletProviderId,
  transaction: KitTransaction,
): Promise<SignatureBytes> {
  // The wire format already has a zero-filled slot for every required
  // signer that hasn't signed yet (ours, specifically), so this is safe to
  // hand to the wallet even though the transaction isn't fully signed —
  // that's exactly what lets Phantom fill in the missing signature itself.
  const wireBase64 = getBase64EncodedWireTransaction(transaction);
  const wireBytes = base64ToBytes(wireBase64);
  const versionedTransaction = VersionedTransaction.deserialize(wireBytes);

  const result = await signAndSendWithInjectedWallet(providerId, versionedTransaction);
  return signatureBytes(getBase58Encoder().encode(result.signature));
}

/** Exported for testing — the one pure conversion in this file's otherwise unverifiable path. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
