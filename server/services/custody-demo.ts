import { generateKeyPairSigner, type Address } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintToInstruction,
  getMintSize,
  getTokenSize,
} from "@solana-program/token-2022";
import {
  buildAssumeCustodyInstruction,
  buildReleaseCustodyInstruction,
} from "../data/policy-program-v2";
import { sendInstructionsWithSigner } from "../data/solana-client";
import type { SolanaClient } from "../data/solana-client";
import { getOwnerTransactionSigner } from "./wallet-connection";
import type { WalletConnectionDTO } from "../dto/wallet.dto";

/**
 * Handing a real token account to the policy program, and taking it back.
 *
 * Custody was verified on devnet long before this file existed, but only from
 * a script — the dashboard could report whether custody was held and never let
 * anyone reach that state, so the panel was permanently stuck on "you do". This
 * makes the transition something the owner performs, with their own wallet, on
 * an account they can open in an explorer.
 *
 * The account created here is an ordinary Token-2022 account without the
 * confidential-transfer extension. That is a deliberate scope choice, not an
 * oversight: configuring a confidential account needs ElGamal key derivation
 * and a validity proof in the browser, and the confidential path is already
 * proven end to end by `npm run verify-custody`. The mechanism being shown —
 * who the `owner` field points at, and who can move funds afterwards — is
 * identical either way, which is exactly why the program takes the token
 * program as a parameter rather than hardcoding one.
 */

const DECIMALS = 6;
const DEMO_SUPPLY = 500_000_000n;

export interface CustodyAccountDTO {
  readonly mint: string;
  readonly tokenAccount: string;
  readonly signature: string;
}

export interface CreateCustodyAccountParams {
  readonly client: SolanaClient;
  readonly ownerWallet: WalletConnectionDTO;
}

/**
 * Creates a funded token account the owner controls, in one transaction.
 *
 * One transaction rather than three because every extra one is another wallet
 * prompt, and a prompt the user cannot distinguish from the meaningful one is
 * how people learn to click through them.
 */
export async function createCustodyAccount(
  params: CreateCustodyAccountParams,
): Promise<CustodyAccountDTO> {
  const owner = getOwnerTransactionSigner(params.ownerWallet);
  const mint = await generateKeyPairSigner();
  const tokenAccount = await generateKeyPairSigner();

  const mintSpace = BigInt(getMintSize());
  const tokenSpace = BigInt(getTokenSize());
  const [mintRent, tokenRent] = await Promise.all([
    params.client.rpc.getMinimumBalanceForRentExemption(mintSpace).send(),
    params.client.rpc.getMinimumBalanceForRentExemption(tokenSpace).send(),
  ]);

  const signature = await sendInstructionsWithSigner(params.client, owner, [
    getCreateAccountInstruction({
      payer: owner,
      newAccount: mint,
      lamports: mintRent,
      space: mintSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction(
      { mint: mint.address, decimals: DECIMALS, mintAuthority: owner.address, freezeAuthority: null },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
    getCreateAccountInstruction({
      payer: owner,
      newAccount: tokenAccount,
      lamports: tokenRent,
      space: tokenSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccount3Instruction(
      { account: tokenAccount.address, mint: mint.address, owner: owner.address },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
    getMintToInstruction(
      { mint: mint.address, token: tokenAccount.address, mintAuthority: owner, amount: DEMO_SUPPLY },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
  ]);

  return { mint: mint.address, tokenAccount: tokenAccount.address, signature };
}

export interface CustodyTransitionParams {
  readonly client: SolanaClient;
  readonly ownerWallet: WalletConnectionDTO;
  readonly policyAccount: Address;
  readonly tokenAccount: Address;
}

/** Owner signs away ownership; from here only the program can move the funds. */
export async function handOverCustody(params: CustodyTransitionParams): Promise<string> {
  const owner = getOwnerTransactionSigner(params.ownerWallet);
  return sendInstructionsWithSigner(params.client, owner, [
    buildAssumeCustodyInstruction({
      policyAccount: params.policyAccount,
      owner,
      tokenAccount: params.tokenAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ]);
}

/**
 * The way back out. Unconditional on the program's side — no policy check, no
 * clock, no dependency on the spend budget — so this cannot stop working
 * because of anything the agent did.
 */
export async function takeBackCustody(params: CustodyTransitionParams): Promise<string> {
  const owner = getOwnerTransactionSigner(params.ownerWallet);
  return sendInstructionsWithSigner(params.client, owner, [
    buildReleaseCustodyInstruction({
      policyAccount: params.policyAccount,
      owner,
      tokenAccount: params.tokenAccount,
      newAuthority: owner.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ]);
}

/**
 * Who the token account currently answers to, read from chain rather than
 * inferred from whatever the UI last did.
 */
export async function readTokenAccountOwner(
  client: SolanaClient,
  tokenAccount: Address,
): Promise<string> {
  const account = await fetchToken(client.rpc, tokenAccount);
  return account.data.owner;
}
