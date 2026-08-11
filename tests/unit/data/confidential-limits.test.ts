import { describe, it, expect } from "vitest";
import { ElGamalCiphertext, ElGamalKeypair } from "@solana/zk-sdk/node";
import {
  MAX_PROVABLE_DIFFERENCE,
  RANGE_BIT_LENGTH,
  buildConfidentialAuthorization,
  encryptLimit,
  encryptedZero,
} from "@data/confidential-limits";
import { addCiphertexts, subtractCiphertexts } from "@data/elgamal-arithmetic";

/**
 * These tests are about the two things that make the scheme sound, and they
 * check them the hard way rather than by trusting the library:
 *
 *  - the proofs are bound to the ciphertexts the *program* will recompute
 *    on-chain, so a prover cannot answer a different question;
 *  - a spend outside the limit has no provable statement at all.
 */

const MAX_PER_TRANSFER = 20_000_000n;
const MAX_PER_PERIOD = 50_000_000n;

function freshPolicy(spent = 0n) {
  const keypair = new ElGamalKeypair();
  const state = {
    maxPerTransferCt: encryptLimit(keypair, MAX_PER_TRANSFER),
    maxPerPeriodCt: encryptLimit(keypair, MAX_PER_PERIOD),
    spentInPeriodCt: spent === 0n ? encryptedZero() : encryptLimit(keypair, spent),
  };
  const values = {
    maxPerTransfer: MAX_PER_TRANSFER,
    maxPerPeriod: MAX_PER_PERIOD,
    spentInPeriod: spent,
  };
  return { keypair, state, values };
}

function ciphertext(bytes: Uint8Array): ElGamalCiphertext {
  const value = ElGamalCiphertext.fromBytes(bytes);
  if (!value) throw new Error("invalid ciphertext in test fixture");
  return value;
}

/** The equality proof's context is pubkey(32) | ciphertext(64) | commitment(32). */
function equalityContext(proof: Uint8Array) {
  return {
    pubkey: proof.slice(0, 32),
    ciphertext: proof.slice(32, 96),
    commitment: proof.slice(96, 128),
  };
}

/** The range proof's context is commitments[8] then bit_lengths[8]. */
function rangeContext(proof: Uint8Array) {
  return {
    commitments: Array.from({ length: 8 }, (_, i) => proof.slice(i * 32, i * 32 + 32)),
    bitLengths: Array.from(proof.slice(256, 264)),
  };
}

describe("encrypting a limit", () => {
  it("produces a 64-byte ElGamal ciphertext", () => {
    const keypair = new ElGamalKeypair();
    expect(encryptLimit(keypair, MAX_PER_TRANSFER).length).toBe(64);
  });

  it("hides the value — the same limit encrypts differently every time", () => {
    const keypair = new ElGamalKeypair();
    const first = encryptLimit(keypair, MAX_PER_TRANSFER);
    const second = encryptLimit(keypair, MAX_PER_TRANSFER);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  it("treats all-zero bytes as the encryption of zero", () => {
    expect(encryptedZero()).toEqual(new Uint8Array(64));
  });
});

describe("authorizing a spend within the limits", () => {
  const { keypair, state, values } = freshPolicy();
  const amount = 5_000_000n;
  const authorization = buildConfidentialAuthorization(keypair, state, values, amount);

  it("returns an amount ciphertext the program can combine homomorphically", () => {
    expect(authorization.amountCiphertext.length).toBe(64);
  });

  it("can bind proofs to the transfer protocol's exact randomized ciphertext", () => {
    const transferCiphertext = keypair.pubkey().encryptU64(amount).toBytes();
    const bound = buildConfidentialAuthorization(
      keypair,
      state,
      values,
      amount,
      transferCiphertext,
    );
    expect(bound.amountCiphertext).toEqual(transferCiphertext);
  });

  /**
   * The load-bearing assertion. The program does not trust any ciphertext the
   * caller supplies for the difference — it recomputes it from stored state.
   * If the proof were bound to anything else, it would be a proof about a
   * different pair of numbers and the on-chain check would (correctly) refuse.
   */
  it("binds the transfer proof to the difference the program recomputes on-chain", () => {
    const expected = subtractCiphertexts(
      ciphertext(state.maxPerTransferCt),
      ciphertext(authorization.amountCiphertext),
    ).toBytes();

    expect(Buffer.from(equalityContext(authorization.transferEqualityProof).ciphertext)).toEqual(
      Buffer.from(expected),
    );
  });

  it("binds the period proof to spent + amount, also recomputed on-chain", () => {
    const newSpent = addCiphertexts(
      ciphertext(state.spentInPeriodCt),
      ciphertext(authorization.amountCiphertext),
    );
    const expected = subtractCiphertexts(ciphertext(state.maxPerPeriodCt), newSpent).toBytes();

    expect(Buffer.from(equalityContext(authorization.periodEqualityProof).ciphertext)).toEqual(
      Buffer.from(expected),
    );
  });

  it("proves both statements under the policy's own key", () => {
    const pubkey = keypair.pubkey().toBytes();
    for (const proof of [authorization.transferEqualityProof, authorization.periodEqualityProof]) {
      expect(Buffer.from(equalityContext(proof).pubkey)).toEqual(Buffer.from(pubkey));
    }
  });

  /**
   * Each equality proof alone is compatible with a negative value; the range
   * proof is what rules that out. It only does so if it covers the very
   * commitments those proofs bound.
   */
  it("covers exactly the two commitments the equality proofs bound, in order", () => {
    const range = rangeContext(authorization.rangeProof);
    expect(Buffer.from(range.commitments[0]!)).toEqual(
      Buffer.from(equalityContext(authorization.transferEqualityProof).commitment),
    );
    expect(Buffer.from(range.commitments[1]!)).toEqual(
      Buffer.from(equalityContext(authorization.periodEqualityProof).commitment),
    );
  });

  it("splits its 64-bit budget 32/32 and leaves the other slots empty", () => {
    const range = rangeContext(authorization.rangeProof);
    expect(range.bitLengths).toEqual([RANGE_BIT_LENGTH, RANGE_BIT_LENGTH, 0, 0, 0, 0, 0, 0]);
    for (let slot = 2; slot < 8; slot++) {
      expect(range.commitments[slot]).toEqual(new Uint8Array(32));
    }
  });
});

describe("authorizing a spend outside the limits", () => {
  it("refuses a transfer above the per-transfer limit", () => {
    const { keypair, state, values } = freshPolicy();
    expect(() =>
      buildConfidentialAuthorization(keypair, state, values, MAX_PER_TRANSFER + 1n),
    ).toThrow(/per-transfer limit/);
  });

  it("refuses a transfer that would exceed the period limit", () => {
    const { keypair, state, values } = freshPolicy(MAX_PER_PERIOD - 1n);
    expect(() => buildConfidentialAuthorization(keypair, state, values, 1_000_000n)).toThrow(
      /period limit/,
    );
  });

  /**
   * Every individual spend can be inside the per-transfer limit while the
   * period budget runs out — the accumulator is the point of encrypting the
   * spent total rather than only the ceilings.
   */
  it("refuses once the encrypted period total is exhausted, even for a small spend", () => {
    const { keypair, state, values } = freshPolicy(MAX_PER_PERIOD);
    expect(() => buildConfidentialAuthorization(keypair, state, values, 1n)).toThrow(
      /period limit/,
    );
  });

  it("refuses a difference too large for the range proof rather than proving nothing", () => {
    const keypair = new ElGamalKeypair();
    const huge = MAX_PROVABLE_DIFFERENCE + 1_000_000n;
    const state = {
      maxPerTransferCt: encryptLimit(keypair, huge),
      maxPerPeriodCt: encryptLimit(keypair, huge),
      spentInPeriodCt: encryptedZero(),
    };
    const values = { maxPerTransfer: huge, maxPerPeriod: huge, spentInPeriod: 0n };

    expect(() => buildConfidentialAuthorization(keypair, state, values, 1n)).toThrow(
      /range proof can cover/,
    );
  });
});
