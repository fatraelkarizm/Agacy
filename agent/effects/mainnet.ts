import { Connection, Keypair } from "@solana/web3.js";
import type { AgentEffects } from "../tools/toolkit.js";
import { executeSwap, fetchSwapQuote, fetchTokenPrice } from "./jupiter.js";

/**
 * Mainnet effects. Deliberately narrow: this build only wires *swapping* to
 * mainnet, because that is the one action with no devnet equivalent at all
 * (see jupiter.ts). Confidential transfer and the devnet faucet are refused
 * before reaching this module — see the cluster checks in tools/toolkit.ts —
 * so `payConfidentially` and `requestDevnetAirdrop` here exist only to satisfy
 * the `AgentEffects` interface and should be unreachable in practice.
 */

export interface MainnetEffectsDeps {
  readonly connection: Connection;
  readonly payer: Keypair;
}

export function buildMainnetEffects(deps: MainnetEffectsDeps): AgentEffects {
  return {
    async payConfidentially() {
      throw new Error(
        "Unreachable: pay_vendor_confidentially refuses on mainnet before calling this effect.",
      );
    },
    async requestDevnetAirdrop() {
      throw new Error(
        "Unreachable: request_devnet_airdrop refuses on mainnet before calling this effect.",
      );
    },
    fetchTokenPrice: ({ mint }) => fetchTokenPrice(mint),
    fetchSwapQuote,
    async executeSwap({ inputMint, outputMint, amountLamports }) {
      const quote = await fetchSwapQuote({ inputMint, outputMint, amountLamports });
      return executeSwap({ connection: deps.connection, payer: deps.payer, quote });
    },
  };
}
