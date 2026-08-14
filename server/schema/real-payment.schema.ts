import { z } from "zod";

const addressSchema = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const vendorPaymentProfileSchema = z.object({
  version: z.literal(1),
  network: z.literal("devnet"),
  walletAddress: addressSchema,
  mint: addressSchema,
  tokenAccount: addressSchema,
  elGamalPubkeyBase64: z.string().trim().min(40).max(48),
  provisioningSignature: z.string().trim().min(80).max(100),
});
