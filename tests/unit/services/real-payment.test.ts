import { describe, expect, it } from "vitest";
import { parseVendorPaymentProfile } from "@services/real-payment";

const ADDRESS = "7GgTn5S7y9i8xQJHWwRFd1tt9uDAah5i1oX55RxYFYxG";

function profile(elGamalPubkeyBase64 = Buffer.alloc(32, 7).toString("base64")): string {
  return JSON.stringify({
    version: 1,
    network: "devnet",
    walletAddress: ADDRESS,
    mint: ADDRESS,
    tokenAccount: ADDRESS,
    elGamalPubkeyBase64,
    provisioningSignature: "1".repeat(88),
  });
}

describe("vendor payment profile", () => {
  it("accepts a devnet profile with a 32-byte ElGamal public key", () => {
    expect(parseVendorPaymentProfile(profile()).walletAddress).toBe(ADDRESS);
  });

  it("rejects a profile whose decoded ElGamal key has the wrong length", () => {
    expect(() => parseVendorPaymentProfile(profile(Buffer.alloc(31, 7).toString("base64"))))
      .toThrow("malformed ElGamal public key");
  });
});
