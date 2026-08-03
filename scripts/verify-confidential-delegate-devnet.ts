import "../tests/setup-env.js";
import { createHash } from "node:crypto";
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  unwrapOption,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  getApproveInstruction,
  getConfidentialTransferInstruction,
} from "@solana-program/token-2022";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
  closeContextStateProof,
} from "@solana-program/zk-elgamal-proof";
import { ElGamalPubkey } from "@solana/zk-sdk/node";
import { createDevnetClient } from "../server/data/solana-client.js";
import { loadOrCreatePayer } from "../server/data/solana-payer.js";
import { createConfidentialMint, sendInstructions } from "../server/data/confidential-mint.js";
import { createConfidentialTokenAccount } from "../server/data/confidential-account.js";
import { deriveConfidentialKeys } from "../server/data/confidential-keys.js";
import { depositToConfidentialBalance, applyPendingBalance } from "../server/data/confidential-transfer.js";
import { fetchConfidentialBalance } from "../server/data/confidential-balance.js";
import { generateTransferProofs } from "../server/data/confidential-proofs.js";
import { extractHandleCiphertext } from "../server/data/elgamal-arithmetic.js";

/**
 * Attempts to wire the delegate-binding CPI mechanism (proven against
 * classic SPL Token in verify-delegate-binding-devnet.ts) to a real
 * Token-2022 confidential transfer, using a real devnet approval — not a
 * reading of documentation, since the documentation does not say either way.
 *
 * The result is a **confirmed negative**, not a bug in this codebase: even
 * with the policy PDA correctly set as the token account's SPL delegate
 * (verified on-chain below, `delegatedAmount` set to the u64::MAX
 * "unlimited" sentinel), Token-2022's confidential Transfer instruction
 * rejects it with `TokenError::OwnerMismatch` — the exact same error, at the
 * exact same compute-unit cost, regardless of the approved amount. That
 * means the instruction does not consult the delegate/delegated_amount
 * fields at all for confidential transfers; the authority must literally be
 * the account owner. See docs/PRIVACY_ARCHITECTURE.md section 14.5 for what
 * this rules out and what it would take instead.
 *
 * Run with: npx tsx scripts/verify-confidential-delegate-devnet.ts
 */

const PROGRAM_ID = address("783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G");
const AccountRole = { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 } as const;
const AUDITOR_HANDLE_INDEX = 2;
const TOKEN_OWNER_MISMATCH_CODE = 4;

const DECIMALS = 6;
const DEPOSIT = 10_000_000n;
const MAX_PER_TRANSFER = 4_000_000n;
const MAX_PER_PERIOD = 8_000_000n;
const PERIOD_SECONDS = 3_600n;
const DELEGATE_APPROVAL = 2n ** 64n - 1n; // u64::MAX — the "unlimited" sentinel
const TRANSFER = 2_500_000n;

const pause = () => new Promise((resolve) => setTimeout(resolve, 3_000));

function anchorDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** True only for the exact on-chain rejection this script exists to confirm. */
function isTokenOwnerMismatch(error: unknown): boolean {
  const context = (error as { cause?: { context?: { code?: number } } })?.cause?.context;
  return context?.code === TOKEN_OWNER_MISMATCH_CODE;
}

async function main(): Promise<void> {
  const client = createDevnetClient();
  const payer = await loadOrCreatePayer();
  const addressEncoder = getAddressEncoder();

  const senderKeys = deriveConfidentialKeys(new Uint8Array(64).fill(44));
  const recipientKeys = deriveConfidentialKeys(new Uint8Array(64).fill(55));
  const recipientOwner = await generateKeyPairSigner();
  const agent = await generateKeyPairSigner();

  console.log("payer (owner):", payer.address);
  console.log("agent:", agent.address);

  const { mint } = await createConfidentialMint(client, payer, {
    decimals: DECIMALS,
    authority: payer.address,
    autoApproveNewAccounts: true,
  });
  console.log("mint:", mint);

  const { tokenAccount: senderAccount } = await createConfidentialTokenAccount(
    client, payer, payer, mint, senderKeys,
  );
  const { tokenAccount: recipientAccount } = await createConfidentialTokenAccount(
    client, payer, recipientOwner, mint, recipientKeys,
  );
  console.log("sender:", senderAccount, "\nrecipient:", recipientAccount);

  await depositToConfidentialBalance(client, payer, payer, {
    tokenAccount: senderAccount, mint, owner: payer, amount: DEPOSIT, decimals: DECIMALS,
  });
  await applyPendingBalance(client, payer, {
    tokenAccount: senderAccount, owner: payer, keys: senderKeys,
    newAvailableBalance: DEPOSIT, expectedPendingCreditCounter: 1n,
  });
  console.log(`sender funded with ${DEPOSIT} confidential balance.\n`);

  const [policyPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode("policy"),
      addressEncoder.encode(payer.address),
      addressEncoder.encode(agent.address),
    ],
  });
  console.log("policy PDA:", policyPda);

  await sendInstructions(client, payer, [
    {
      programAddress: PROGRAM_ID,
      accounts: [
        { address: policyPda, role: AccountRole.WRITABLE },
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: concatBytes([
        anchorDiscriminator("initialize"),
        addressEncoder.encode(agent.address),
        u64le(MAX_PER_TRANSFER),
        u64le(MAX_PER_PERIOD),
        i64le(PERIOD_SECONDS),
      ]),
    },
  ]);
  console.log("policy initialized: max_per_transfer =", MAX_PER_TRANSFER, "max_per_period =", MAX_PER_PERIOD);

  await sendInstructions(client, payer, [
    getApproveInstruction({ source: senderAccount, delegate: policyPda, owner: payer, amount: DELEGATE_APPROVAL }),
  ]);

  const senderAccountState = await fetchToken(client.rpc, senderAccount);
  const onChainDelegate = unwrapOption(senderAccountState.data.delegate);
  const delegateConfirmed = onChainDelegate === policyPda
    && senderAccountState.data.delegatedAmount === DELEGATE_APPROVAL;
  console.log(
    "owner approved the policy PDA as Token-2022 delegate — confirmed on-chain:",
    delegateConfirmed, `(delegate: ${onChainDelegate}, delegatedAmount: ${senderAccountState.data.delegatedAmount})\n`,
  );
  if (!delegateConfirmed) {
    throw new Error("Approve did not actually set the expected delegate/delegatedAmount — cannot proceed with the test.");
  }

  const senderBefore = await fetchConfidentialBalance(client, senderAccount, senderKeys);

  console.log(`attempting authorize_and_invoke(${TRANSFER}) as a real Token-2022 confidential transfer via CPI...`);
  let outcome: "succeeded" | "confirmed_owner_mismatch";
  let signature: string | undefined;
  let remainingBalance: bigint | undefined;
  try {
    const result = await confidentialCpiTransfer(client, payer, agent, policyPda, {
      sourceToken: senderAccount,
      destinationToken: recipientAccount,
      mint,
      senderKeys,
      recipientElGamalPubkey: recipientKeys.elGamal.pubkey(),
      availableBalance: senderBefore.availableBalance,
      availableBalanceCiphertext: senderBefore.availableBalanceCiphertext,
      amount: TRANSFER,
    });
    signature = result.signature;
    remainingBalance = result.remainingBalance;
    outcome = "succeeded";
  } catch (error) {
    if (!isTokenOwnerMismatch(error)) throw error;
    outcome = "confirmed_owner_mismatch";
  }

  if (outcome === "confirmed_owner_mismatch") {
    console.log(
      "\nCONFIRMED (not assumed): Token-2022's confidential Transfer instruction rejected the policy PDA even",
      "though it is the token account's verified on-chain delegate with an unlimited allowance. The on-chain error",
      "is TokenError::OwnerMismatch — the instruction requires authority to literally be the account owner and does",
      "not consult the delegate/delegatedAmount fields for confidential transfers at all.",
    );
    console.log(
      "\nThis means delegate binding cannot be extended to Token-2022 confidential transfer by CPI wiring alone,",
      "regardless of how the accounts are forwarded — see docs/PRIVACY_ARCHITECTURE.md section 14.5 for what this",
      "rules out and the (larger, architecture-level) alternative it leaves open.",
    );
    return;
  }

  // Unexpected: if this ever runs on a future Token-2022 version that adds
  // delegate support, verify it actually moved real value rather than
  // silently trusting a changed error surface.
  const senderAfter = await fetchConfidentialBalance(client, senderAccount, senderKeys);
  if (senderAfter.availableBalance !== remainingBalance || senderAfter.availableBalance !== DEPOSIT - TRANSFER) {
    throw new Error("Transfer instruction succeeded but the sender's balance did not move as expected.");
  }
  await applyPendingBalance(client, payer, {
    tokenAccount: recipientAccount, owner: recipientOwner, keys: recipientKeys,
    newAvailableBalance: TRANSFER, expectedPendingCreditCounter: 1n,
  });
  const recipientAfter = await fetchConfidentialBalance(client, recipientAccount, recipientKeys);
  if (recipientAfter.availableBalance !== TRANSFER) {
    throw new Error("Transfer instruction succeeded but the recipient never received the transferred amount.");
  }
  console.log(
    "\nUNEXPECTED (in a good way): this Token-2022 build accepted the delegate as confidential-transfer authority,",
    "and the transfer verifiably moved real value end to end. Signature:", signature,
    "\nUpdate docs/PRIVACY_ARCHITECTURE.md section 14 — this was previously a confirmed protocol limitation.",
  );
}

interface ConfidentialCpiParams {
  readonly sourceToken: ReturnType<typeof address>;
  readonly destinationToken: ReturnType<typeof address>;
  readonly mint: ReturnType<typeof address>;
  readonly senderKeys: ReturnType<typeof deriveConfidentialKeys>;
  readonly recipientElGamalPubkey: ElGamalPubkey;
  readonly availableBalance: bigint;
  readonly availableBalanceCiphertext: Awaited<ReturnType<typeof fetchConfidentialBalance>>["availableBalanceCiphertext"];
  readonly amount: bigint;
}

/**
 * Generates a real confidential-transfer proof set (identical math to an
 * ordinary transfer — see confidential-transfer.ts), then submits the
 * transfer itself through `authorize_and_invoke` instead of directly, so the
 * policy PDA — not the account owner — is the instruction's authority.
 */
async function confidentialCpiTransfer(
  client: ReturnType<typeof createDevnetClient>,
  payer: Awaited<ReturnType<typeof loadOrCreatePayer>>,
  agent: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  policyPda: ReturnType<typeof address>,
  params: ConfidentialCpiParams,
): Promise<{ signature: string; remainingBalance: bigint }> {
  const auditorPubkey = ElGamalPubkey.fromBytes(new Uint8Array(32));

  const proofs = generateTransferProofs({
    senderKeypair: params.senderKeys.elGamal,
    recipientPubkey: params.recipientElGamalPubkey,
    auditorPubkey,
    availableBalance: params.availableBalance,
    amount: params.amount,
    availableBalanceCiphertext: params.availableBalanceCiphertext,
  });

  const equalityContext = await generateKeyPairSigner();
  const validityContext = await generateKeyPairSigner();
  const rangeContext = await generateKeyPairSigner();
  const contextAuthority = payer.address;

  const equalityIxs = await verifyCiphertextCommitmentEquality({
    rpc: client.rpc, payer, proofData: proofs.equality.toBytes(),
    contextState: { contextAccount: equalityContext, authority: contextAuthority },
  });
  const validityIxs = await verifyBatchedGroupedCiphertext3HandlesValidity({
    rpc: client.rpc, payer, proofData: proofs.ciphertextValidity.toBytes(),
    contextState: { contextAccount: validityContext, authority: contextAuthority },
  });
  const rangeIxs = await verifyBatchedRangeProofU128({
    rpc: client.rpc, payer, proofData: proofs.range.toBytes(),
    contextState: { contextAccount: rangeContext, authority: contextAuthority },
  });

  await sendInstructions(client, payer, equalityIxs);
  await pause();
  await sendInstructions(client, payer, validityIxs);
  await pause();
  await sendInstructions(client, payer, rangeIxs.slice(0, -1));
  await pause();
  await sendInstructions(client, payer, rangeIxs.slice(-1));
  await pause();

  // authority is a bare Address, not a TransactionSigner: this account comes
  // back with a non-signer role, exactly what authorize_and_invoke needs —
  // it forces is_signer=true itself, only for the account matching the
  // policy PDA, when it builds the CPI via invoke_signed.
  const transferIx = getConfidentialTransferInstruction({
    sourceToken: params.sourceToken,
    mint: params.mint,
    destinationToken: params.destinationToken,
    authority: policyPda,
    equalityRecord: equalityContext.address,
    ciphertextValidityRecord: validityContext.address,
    rangeRecord: rangeContext.address,
    newSourceDecryptableAvailableBalance: params.senderKeys.ae
      .encrypt(proofs.remainingBalance)
      .toBytes() as never,
    transferAmountAuditorCiphertextLo: extractHandleCiphertext(
      proofs.groupedLo.toBytes(), AUDITOR_HANDLE_INDEX,
    ).toBytes() as never,
    transferAmountAuditorCiphertextHi: extractHandleCiphertext(
      proofs.groupedHi.toBytes(), AUDITOR_HANDLE_INDEX,
    ).toBytes() as never,
    equalityProofInstructionOffset: 0,
    ciphertextValidityProofInstructionOffset: 0,
    rangeProofInstructionOffset: 0,
  });

  const authorizeAndInvokeIx = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: policyPda, role: AccountRole.WRITABLE },
      { address: agent.address, role: AccountRole.READONLY_SIGNER, signer: agent },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...transferIx.accounts,
    ],
    data: concatBytes([
      anchorDiscriminator("authorize_and_invoke"),
      u64le(params.amount),
      u32le(transferIx.data.length),
      transferIx.data,
    ]),
  };

  try {
    const signature = await sendInstructions(client, payer, [authorizeAndInvokeIx]);
    return { signature, remainingBalance: proofs.remainingBalance };
  } finally {
    await pause();
    try {
      await sendInstructions(client, payer, [
        closeContextStateProof({ contextState: equalityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: validityContext.address, authority: payer, destination: payer.address }),
        closeContextStateProof({ contextState: rangeContext.address, authority: payer, destination: payer.address }),
      ]);
    } catch (cause) {
      console.warn("context state cleanup failed (rent not reclaimed):", (cause as Error).message);
    }
  }
}

await main();
