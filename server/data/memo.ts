import { address } from "@solana/kit";

/**
 * The SPL Memo v2 program — a stable, well-known Solana program ID, not
 * something Agacy deploys. Used to carry the encrypted reasoning ciphertext
 * on-chain: a memo instruction needs no accounts, its instruction data is
 * just raw bytes, which makes it the simplest way to attach arbitrary
 * verifiable data to a transaction without a custom program.
 */
export const MEMO_PROGRAM_ID = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export function buildMemoInstruction(data: Uint8Array) {
  return {
    programAddress: MEMO_PROGRAM_ID,
    accounts: [],
    data,
  };
}
