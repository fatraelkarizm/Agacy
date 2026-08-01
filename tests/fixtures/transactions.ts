import type { AuthorizedTransactionDTO } from "@dto/transaction.dto";
import type { SpendPolicyDTO } from "@dto/agent.dto";

export const authorizedTx: AuthorizedTransactionDTO = {
  signature: "5xTestSig111111111111111111111111111111111111",
  timestamp: 1_754_000_000_000,
  status: "confirmed",
  confidential: true,
  amount: 4_200_000n,
  counterparty: "RecipientPubkey11111111111111111111111111111",
  resultingBalance: 95_800_000n,
  agentReasoning: "Monthly subscription payment, within the configured budget.",
};

export const defaultPolicy: SpendPolicyDTO = {
  maxPerTransfer: 10_000_000n,
  maxPerPeriod: 50_000_000n,
  allowedRecipients: [],
};
