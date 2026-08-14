export interface RealTreasuryDTO {
  readonly network: "devnet";
  readonly ownerAddress: string;
  readonly mint: string;
  readonly tokenAccount: string;
  readonly policyAccount: string;
  readonly balanceBaseUnits: string;
  readonly mintSignature: string;
  readonly accountSignature: string;
  readonly fundingSignature: string;
  readonly applySignature: string;
  readonly custodySignature: string;
}

export interface VendorPaymentProfileDTO {
  readonly version: 1;
  readonly network: "devnet";
  readonly walletAddress: string;
  readonly mint: string;
  readonly tokenAccount: string;
  readonly elGamalPubkeyBase64: string;
  readonly provisioningSignature: string;
}
