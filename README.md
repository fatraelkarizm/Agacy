# Agacy

**Agentic Privacy for AI Agents**

A confidential wallet for AI agents on Solana — agents transact autonomously on-chain, but their balance and transaction amounts stay hidden from public view, while remaining cryptographically provable and auditable to whoever is authorized to see them.

Built for NTU InnovateX Hackathon 2026 (NTU CCTF x SNZ).

## How it works
An AI agent transacts on Solana through native **Confidential Transfer** (Token-2022), so its balance and transfer amounts are encrypted on-chain. A public observer sees that a transaction happened; only whoever the owner authorizes can decrypt full detail and the agent's plain-language reasoning for the action.

## Stack
- **Chain:** Solana (devnet for the hackathon build)
- **On-chain privacy:** Solana Confidential Transfer (Token-2022 extension), with Arcium Confidential SPL as a stretch goal for confidential spend-limit logic
- **Agent layer:** Solana Agent Kit
- **App:** Next.js + TypeScript

## Verified on devnet

| | |
|---|---|
| Confidential transfer | [`5vTuKeoULGc…`](https://explorer.solana.com/tx/5vTuKeoULGc26FdNoxCVErWbYzet1jReDhgRqvp2Le9erDsWTx8p4P4VCGotC9mwFHaifazLeAbzq2mpCLwqAEtz?cluster=devnet) |
| Spend policy program | [`AmJYcUrs36n…`](https://explorer.solana.com/address/AmJYcUrs36nwpiEZxJDB5q49LbXypBVujNVMvKMWg19e?cluster=devnet) |
| Transferred amount readable on-chain | **No** — verified by reading the recipient account bytes |

92 tests passing (82 TypeScript, 10 Rust).

## Run it

```bash
npm install
npm run dev            # landing page + live agent demo
npm test               # unit tests
npm run test:integration   # devnet round trip (needs AGACY_RPC_URL)
npm run capture-proof      # re-record the on-chain evidence
```

## Project docs
Planning documents (`PRD`, `FEATURES`, `INFRASTRUCTURE`, `ARCHITECTURE`, competitive/market research) are kept local and are not published to this repo — see `AGENTS.md` for the contributor-facing summary of architecture rules and available agent skills.
