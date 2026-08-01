/**
 * The public/authorized split is the product's core safety property.
 *
 * PublicTransactionDTO is a *closed* shape: it carries no amount, balance, or
 * counterparty field at all. AuthorizedTransactionDTO deliberately does NOT
 * extend it — extending would let an AuthorizedTransactionDTO be passed
 * anywhere a PublicTransactionDTO is expected, which is exactly the leak we
 * are trying to make impossible. Converting between them is explicit
 * (`toPublicView`), so a leak requires deleting code, not just forgetting a check.
 */

export type TransactionStatus = "confirmed" | "pending" | "failed";

/** What any unauthenticated observer (or a block explorer) is allowed to see. */
export interface PublicTransactionDTO {
  readonly signature: string;
  readonly timestamp: number;
  readonly status: TransactionStatus;
  /** Always true for Agacy transfers — signals the amount is encrypted on-chain. */
  readonly confidential: true;
}

/** What the owner (or an explicitly authorized party) can decrypt and see. */
export interface AuthorizedTransactionDTO {
  readonly signature: string;
  readonly timestamp: number;
  readonly status: TransactionStatus;
  readonly confidential: true;
  /** Decrypted transfer amount, in base units of the token. */
  readonly amount: bigint;
  readonly counterparty: string;
  /** Decrypted available balance after this transfer, in base units. */
  readonly resultingBalance: bigint;
  /** Plain-language explanation from the agent for why it made this transfer. */
  readonly agentReasoning: string;
}

/**
 * The only sanctioned way to derive a public view from authorized data.
 * Field-by-field construction (not spread-and-delete) so adding a sensitive
 * field to AuthorizedTransactionDTO can never silently leak into the public view.
 */
export function toPublicView(tx: AuthorizedTransactionDTO): PublicTransactionDTO {
  return {
    signature: tx.signature,
    timestamp: tx.timestamp,
    status: tx.status,
    confidential: true,
  };
}
