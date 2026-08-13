/**
 * A real Token-2022 confidential transfer, reached through this app's own
 * server route.
 *
 * The transfer needs a funded payer and a provisioned confidential mint. The
 * browser session has neither — it holds a session agent key with no SOL and no
 * confidential balance — so the work happens in app/api/agent/confidential-payment
 * and only the result comes back here.
 */

export interface ConfidentialPaymentReceipt {
  readonly signature: string;
  readonly mint: string;
  readonly recipient: string;
  readonly amountTokens: number;
  /** Read back from the recipient's account bytes, not assumed. */
  readonly amountReadableOnChain: boolean;
  readonly elapsedMs: number;
  readonly explorerUrl: string;
}

export async function payConfidentially(amountTokens: number): Promise<ConfidentialPaymentReceipt> {
  const response = await fetch("/api/agent/confidential-payment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountTokens }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Confidential transfer failed: ${response.status}`);
  }
  return (await response.json()) as ConfidentialPaymentReceipt;
}
