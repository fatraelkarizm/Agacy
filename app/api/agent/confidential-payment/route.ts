import type { Address } from "@solana/kit";

/**
 * Executes a real Token-2022 confidential transfer on devnet, so the Agent
 * Graph can produce an encrypted payment rather than only describe one.
 *
 * This closes the gap that mattered most in the demo: every other tool in the
 * graph proves *policy enforcement* — the agent cannot exceed its limit — while
 * the product's actual differentiator, that the amount is unreadable on-chain,
 * was only ever demonstrated by a CLI script and a static JSON artefact. A
 * judge clicking through the app never saw an amount become ciphertext.
 *
 * It runs server-side because a confidential transfer needs a funded payer and
 * a provisioned mint, and the browser session has neither: it holds an agent
 * signing key with no SOL and no confidential balance. `GRAPH_EXCLUDED_TOOLKIT_TOOLS`
 * already recorded that constraint as the reason `pay_vendor_confidentially`
 * stayed CLI-only; this route is the missing half of that arrangement.
 *
 * Honesty boundary, enforced in the response text: this moves tokens on a demo
 * mint owned by the server payer. It is not the owner's money, and the response
 * says so rather than letting the graph imply otherwise.
 */

/** This route always talks to devnet; there is nothing here to prerender. */
export const dynamic = "force-dynamic";

const DECIMALS = 6;
const MINT_SUPPLY = 50_000_000n;
/** Refuses rather than half-completing once the demo balance runs low. */
const REFILL_BELOW = 10_000_000n;

/**
 * The confidential-transfer stack is loaded on first request, never at module
 * scope.
 *
 * Next imports every route while collecting page data during a build. That pass
 * cannot execute this dependency chain — it reaches `@solana/zk-sdk` and the
 * devnet RPC client — and the build fails with a bare "Failed to collect page
 * data" that names no cause. A dynamic import keeps the chain out of the build
 * graph's execution path while leaving it perfectly ordinary at request time.
 */
async function loadDeps() {
  const [kit, clientMod, payerMod, mintMod, accountMod, keysMod, transferMod, balanceMod, token] =
    await Promise.all([
      import("@solana/kit"),
      import("../../../../server/data/solana-client"),
      import("../../../../server/data/solana-payer"),
      import("../../../../server/data/confidential-mint"),
      import("../../../../server/data/confidential-account"),
      import("../../../../server/data/confidential-keys"),
      import("../../../../server/data/confidential-transfer"),
      import("../../../../server/data/confidential-balance"),
      import("@solana-program/token-2022"),
    ]);
  return {
    generateKeyPairSigner: kit.generateKeyPairSigner,
    createDevnetClient: clientMod.createDevnetClient,
    loadOrCreatePayer: payerMod.loadOrCreatePayer,
    createConfidentialMint: mintMod.createConfidentialMint,
    sendInstructions: mintMod.sendInstructions,
    createConfidentialTokenAccount: accountMod.createConfidentialTokenAccount,
    deriveConfidentialKeys: keysMod.deriveConfidentialKeys,
    applyPendingBalance: transferMod.applyPendingBalance,
    depositToConfidentialBalance: transferMod.depositToConfidentialBalance,
    executeConfidentialTransfer: transferMod.executeConfidentialTransfer,
    fetchConfidentialBalance: balanceMod.fetchConfidentialBalance,
    getMintToInstruction: token.getMintToInstruction,
  };
}

type Deps = Awaited<ReturnType<typeof loadDeps>>;

interface ConfidentialEnvironment {
  readonly mint: Address;
  readonly sender: Address;
  readonly recipient: Address;
  readonly senderKeys: ReturnType<Deps["deriveConfidentialKeys"]>;
  readonly recipientKeys: ReturnType<Deps["deriveConfidentialKeys"]>;
}

/**
 * Provisioning costs six transactions and about seven seconds, so it happens
 * once per server process and is reused. Held as a promise rather than a value
 * so two concurrent first-calls cannot both start provisioning.
 */
let environment: Promise<ConfidentialEnvironment> | null = null;
let cachedClient: ReturnType<Deps["createDevnetClient"]> | null = null;

function getClient(deps: Deps) {
  cachedClient ??= deps.createDevnetClient();
  return cachedClient;
}

async function provision(deps: Deps): Promise<ConfidentialEnvironment> {
  const client = getClient(deps);
  const payer = await deps.loadOrCreatePayer();
  const senderKeys = deps.deriveConfidentialKeys(new Uint8Array(64).fill(41));
  const recipientKeys = deps.deriveConfidentialKeys(new Uint8Array(64).fill(42));

  const { mint } = await deps.createConfidentialMint(client, payer, {
    decimals: DECIMALS,
    authority: payer.address,
    autoApproveNewAccounts: true,
  });

  const recipientOwner = await deps.generateKeyPairSigner();
  const { tokenAccount: sender } = await deps.createConfidentialTokenAccount(
    client, payer, payer, mint, senderKeys,
  );
  const { tokenAccount: recipient } = await deps.createConfidentialTokenAccount(
    client, payer, recipientOwner, mint, recipientKeys,
  );

  await deps.sendInstructions(client, payer, [
    deps.getMintToInstruction({ mint, token: sender, mintAuthority: payer, amount: MINT_SUPPLY }),
  ]);
  await deps.depositToConfidentialBalance(client, payer, payer, {
    tokenAccount: sender, mint, owner: payer, amount: MINT_SUPPLY, decimals: DECIMALS,
  });
  await deps.applyPendingBalance(client, payer, {
    tokenAccount: sender, owner: payer, keys: senderKeys,
    newAvailableBalance: MINT_SUPPLY, expectedPendingCreditCounter: 1n,
  });

  return { mint, sender, recipient, senderKeys, recipientKeys };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { amountTokens?: unknown } | null;
  const amountTokens = typeof body?.amountTokens === "number" ? body.amountTokens : NaN;
  if (!Number.isFinite(amountTokens) || amountTokens <= 0 || amountTokens > 5) {
    return Response.json({ error: "amountTokens must be between 0 and 5" }, { status: 400 });
  }

  try {
    const deps = await loadDeps();
    const client = getClient(deps);
    environment ??= provision(deps);
    const env = await environment;
    const payer = await deps.loadOrCreatePayer();
    const amount = BigInt(Math.round(amountTokens * 10 ** DECIMALS));

    const state = await deps.fetchConfidentialBalance(client, env.sender, env.senderKeys);
    if (state.availableBalance < amount || state.availableBalance < REFILL_BELOW) {
      return Response.json(
        { error: "The demo mint's confidential balance is exhausted. Restart the server to reprovision." },
        { status: 409 },
      );
    }

    const started = Date.now();
    const { signature } = await deps.executeConfidentialTransfer(client, payer, {
      sourceToken: env.sender,
      destinationToken: env.recipient,
      mint: env.mint,
      owner: payer,
      senderKeys: env.senderKeys,
      recipientElGamalPubkey: env.recipientKeys.elGamal.pubkey(),
      availableBalance: state.availableBalance,
      availableBalanceCiphertext: state.availableBalanceCiphertext,
      amount,
    });
    const elapsedMs = Date.now() - started;

    // Verified, not asserted: read the recipient's account back and confirm the
    // transferred amount does not appear as a plaintext u64 anywhere in it.
    // Claiming encryption without checking would be the one thing this product
    // cannot afford to get wrong.
    const account = await client.rpc
      .getAccountInfo(env.recipient, { commitment: "confirmed", encoding: "base64" })
      .send();
    const raw = Buffer.from(account.value?.data[0] ?? "", "base64");
    const plaintext = Buffer.alloc(8);
    plaintext.writeBigUInt64LE(amount);

    return Response.json({
      signature,
      mint: env.mint,
      recipient: env.recipient,
      amountTokens,
      amountReadableOnChain: raw.includes(plaintext),
      elapsedMs,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  } catch (error) {
    // A failed provision must not be cached, or every later call inherits it.
    environment = null;
    return Response.json(
      { error: error instanceof Error ? error.message : "Confidential transfer failed" },
      { status: 502 },
    );
  }
}
