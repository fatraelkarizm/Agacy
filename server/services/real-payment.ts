import {
  address,
  getAddressEncoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { ElGamalPubkey } from "@solana/zk-sdk/node";
import { createConfidentialMintWithSigner } from "../data/confidential-mint";
import { createConfidentialTokenAccountWithSigner } from "../data/confidential-account";
import {
  applyPendingBalanceWithSigner,
  depositToConfidentialBalanceWithSigner,
} from "../data/confidential-transfer";
import { fetchConfidentialBalance } from "../data/confidential-balance";
import { deriveConfidentialKeys, keyDerivationMessage, type ConfidentialKeys } from "../data/confidential-keys";
import { executePolicyConfidentialTransfer } from "../data/policy-confidential-transfer";
import { fetchPolicyV2Account } from "../data/policy-program-v2";
import { getLamportBalance, type SolanaClient } from "../data/solana-client";
import type { PaymentAccountingDTO } from "../dto/agent-graph.dto";
import type { RealTreasuryDTO, VendorPaymentProfileDTO } from "../dto/real-payment.dto";
import type { WalletConnectionDTO } from "../dto/wallet.dto";
import { vendorPaymentProfileSchema } from "../schema/real-payment.schema";
import { handOverCustody, readTokenAccountOwner, takeBackCustody } from "./custody-demo";
import { getOwnerTransactionSigner, signOwnerMessage } from "./wallet-connection";

const DECIMALS = 6;
const SCALE = 10 ** DECIMALS;
let treasurySecrets: { readonly dto: RealTreasuryDTO; readonly keys: ConfidentialKeys } | null = null;

export async function createRealTreasury(params: {
  readonly client: SolanaClient;
  readonly ownerWallet: WalletConnectionDTO;
  readonly policyAccount: string;
  readonly initialTokens: number;
}): Promise<RealTreasuryDTO> {
  if (!Number.isFinite(params.initialTokens) || params.initialTokens <= 0 || params.initialTokens > 1_000) {
    throw new Error("Initial treasury amount must be greater than 0 and no more than 1,000 tokens.");
  }
  const owner = getOwnerTransactionSigner(params.ownerWallet);
  const createdMint = await createConfidentialMintWithSigner(params.client, owner, {
    decimals: DECIMALS,
    authority: owner.address,
    autoApproveNewAccounts: true,
  });
  const keys = await deriveWalletKeys(params.ownerWallet, createdMint.mint);
  const account = await createConfidentialTokenAccountWithSigner(
    params.client, owner, owner, createdMint.mint, keys,
  );
  const amount = BigInt(Math.round(params.initialTokens * SCALE));
  const fundingSignature = await depositToConfidentialBalanceWithSigner(
    params.client,
    owner,
    owner,
    { tokenAccount: account.tokenAccount, mint: createdMint.mint, owner, amount, decimals: DECIMALS },
  );
  const applySignature = await applyPendingBalanceWithSigner(params.client, owner, {
    tokenAccount: account.tokenAccount,
    owner,
    keys,
    newAvailableBalance: amount,
    expectedPendingCreditCounter: 1n,
  });
  const custodySignature = await handOverCustody({
    client: params.client,
    ownerWallet: params.ownerWallet,
    policyAccount: address(params.policyAccount),
    tokenAccount: account.tokenAccount,
  });
  const policy = await fetchPolicyV2Account(params.client, address(params.policyAccount));
  if (policy?.custodiedTokenAccount !== account.tokenAccount) {
    throw new Error("Custody transaction landed but the policy does not own the treasury account.");
  }
  const balance = await fetchConfidentialBalance(params.client, account.tokenAccount, keys);
  const dto: RealTreasuryDTO = {
    network: "devnet",
    ownerAddress: params.ownerWallet.address,
    mint: createdMint.mint,
    tokenAccount: account.tokenAccount,
    policyAccount: params.policyAccount,
    balanceBaseUnits: balance.availableBalance.toString(),
    mintSignature: createdMint.signature,
    accountSignature: account.signature,
    fundingSignature,
    applySignature,
    custodySignature,
  };
  treasurySecrets = { dto, keys };
  return dto;
}

export async function createVendorPaymentProfile(params: {
  readonly client: SolanaClient;
  readonly vendorWallet: WalletConnectionDTO;
  readonly mint: string;
}): Promise<VendorPaymentProfileDTO> {
  const vendor = getOwnerTransactionSigner(params.vendorWallet);
  const mint = address(params.mint);
  const keys = await deriveWalletKeys(params.vendorWallet, mint);
  const account = await createConfidentialTokenAccountWithSigner(
    params.client, vendor, vendor, mint, keys,
  );
  return {
    version: 1,
    network: "devnet",
    walletAddress: params.vendorWallet.address,
    mint: params.mint,
    tokenAccount: account.tokenAccount,
    elGamalPubkeyBase64: bytesToBase64(keys.elGamal.pubkey().toBytes()),
    provisioningSignature: account.signature,
  };
}

export function parseVendorPaymentProfile(value: string): VendorPaymentProfileDTO {
  const profile = vendorPaymentProfileSchema.parse(JSON.parse(value));
  if (base64ToBytes(profile.elGamalPubkeyBase64).length !== 32) {
    throw new Error("Vendor profile contains a malformed ElGamal public key.");
  }
  return profile;
}

export async function recoverRealTreasury(params: {
  readonly client: SolanaClient;
  readonly ownerWallet: WalletConnectionDTO;
  readonly treasury: RealTreasuryDTO;
}): Promise<string> {
  if (params.treasury.ownerAddress !== params.ownerWallet.address) {
    throw new Error("Only the wallet that created this treasury can recover it.");
  }
  const signature = await takeBackCustody({
    client: params.client,
    ownerWallet: params.ownerWallet,
    policyAccount: address(params.treasury.policyAccount),
    tokenAccount: address(params.treasury.tokenAccount),
  });
  const holder = await readTokenAccountOwner(params.client, address(params.treasury.tokenAccount));
  if (holder !== params.ownerWallet.address) {
    throw new Error("Recovery transaction landed, but custody has not returned to the owner wallet.");
  }
  if (treasurySecrets?.dto.tokenAccount === params.treasury.tokenAccount) treasurySecrets = null;
  return signature;
}

export async function executeRealPayment(params: {
  readonly client: SolanaClient;
  readonly agent: KeyPairSigner;
  readonly profile: VendorPaymentProfileDTO;
  readonly amountTokens: number;
}): Promise<{
  readonly signature: string;
  readonly mint: string;
  readonly recipient: string;
  readonly amountReadableOnChain: boolean;
  readonly elapsedMs: number;
  readonly explorerUrl: string;
  readonly accounting: PaymentAccountingDTO;
}> {
  const treasury = treasurySecrets;
  if (!treasury) throw new Error("Create the connected wallet's real confidential treasury first.");
  if (params.profile.mint !== treasury.dto.mint) throw new Error("Vendor profile is for a different mint.");
  if (!Number.isFinite(params.amountTokens) || params.amountTokens <= 0) throw new Error("Payment amount must be positive.");
  const amount = BigInt(Math.round(params.amountTokens * SCALE));
  const before = await fetchConfidentialBalance(
    params.client, address(treasury.dto.tokenAccount), treasury.keys,
  );
  if (before.availableBalance < amount) throw new Error("The real confidential treasury balance is insufficient.");
  const payerSolBefore = await getLamportBalance(params.client, params.agent.address);
  const started = Date.now();
  const result = await executePolicyConfidentialTransfer(params.client, {
    policyAccount: address(treasury.dto.policyAccount),
    sourceToken: address(treasury.dto.tokenAccount),
    destinationToken: address(params.profile.tokenAccount),
    mint: address(treasury.dto.mint),
    agent: params.agent,
    senderKeys: treasury.keys,
    recipientElGamalPubkey: ElGamalPubkey.fromBytes(base64ToBytes(params.profile.elGamalPubkeyBase64)),
    availableBalance: before.availableBalance,
    availableBalanceCiphertext: before.availableBalanceCiphertext,
    amount,
  });
  const payerSolAfter = await getLamportBalance(params.client, params.agent.address);
  const raw = await params.client.rpc
    .getAccountInfo(address(params.profile.tokenAccount), { commitment: "confirmed", encoding: "base64" })
    .send();
  const bytes = base64ToBytes(raw.value?.data[0] ?? "");
  const plaintext = new Uint8Array(8);
  new DataView(plaintext.buffer).setBigUint64(0, amount, true);
  return {
    signature: result.signature,
    mint: treasury.dto.mint,
    recipient: params.profile.tokenAccount,
    amountReadableOnChain: includesBytes(bytes, plaintext),
    elapsedMs: Date.now() - started,
    explorerUrl: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet`,
    accounting: {
      asset: "owner-created devnet token",
      tokenBalanceBefore: before.availableBalance.toString(),
      amountSpent: amount.toString(),
      tokenBalanceAfter: result.remainingBalance.toString(),
      payerSolBeforeLamports: payerSolBefore.toString(),
      transactionFeeLamports: (payerSolBefore - payerSolAfter).toString(),
      payerSolAfterLamports: payerSolAfter.toString(),
    },
  };
}

async function deriveWalletKeys(wallet: WalletConnectionDTO, seed: Address): Promise<ConfidentialKeys> {
  const signature = await signOwnerMessage(
    wallet,
    keyDerivationMessage(new Uint8Array(getAddressEncoder().encode(seed))),
  );
  return deriveConfidentialKeys(signature);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
