# Agacy

**Agentic Privacy for AI Agents**

AI agents are starting to hold and spend real money on their own — treasury bots, procurement
agents, DAO-delegated spenders. Today that means two bad defaults: either the agent's every payment,
balance, and counterparty sits on a fully public ledger forever, or the only "limit" on what it can
spend is a system-prompt instruction a bug or a prompt injection can talk it out of. Agacy is a
confidential agent wallet where **spend limits are a property of an on-chain account, not a request
to the model**, and the agent's balance, transfer amounts, and decision reasoning stay encrypted —
readable only by whoever the owner explicitly authorizes.

Built for NTU InnovateX Hackathon 2026 (NTU CCTF x SNZ).

## Who this is for

A DAO or business delegating a bounded budget to an autonomous agent — paying contributors,
suppliers, or infrastructure vendors — where the **treasury committee, multisig signers, or a
finance lead are "authorized"**: they can decrypt full transaction detail and the agent's reasoning
for audit, while the public (and, pointedly, rival DAOs or competitors trying to estimate your
runway or poach your contributors by reading your treasury's on-chain history) see only that a
transaction happened, not what moved or why. The onboarding flow's "Procurement" persona and the
in-app attacker/competitor simulation both model this exact scenario end to end.

## What's actually original here

**Solana's Token-2022 Confidential Transfer is the rail, not the invention** — it's a protocol
primitive Agacy uses, the same way any app uses SPL Token. The parts built for this project:

- **A spend-policy program that makes limits unbypassable by the agent, not just discouraged.**
  The policy account tracks per-transfer and rolling-period limits on-chain; only the owner can
  raise them, and the agent can only spend what the account allows — not what it claims it needs.
- **The agent's reasoning is encrypted, not just its balance.** Confidential Transfer hides amounts;
  it says nothing about *why* an agent paid. Agacy encrypts the plain-language reasoning under a
  key only the owner holds and carries the ciphertext on-chain in a memo — verified below, not
  just claimed.
- **The public/authorized DTO boundary is enforced by the type system**, not a UI convention — a
  public view is structurally incapable of receiving a decrypted amount, because it's a different
  type, not the same object with a field hidden by a component.
- **A concrete, narrated adversarial model** (`buildAttackSimulation`) showing the actual mechanism
  under attack: the same scan an attacker or competitor would run reveals a target on an ordinary
  wallet and finds nothing to size on Agacy's.

## How it works

The owner connects a wallet and defines an agent with a spending policy (max per transfer, max per
period). Provisioning writes that policy to a real devnet account the agent cannot self-modify. The
agent proposes payments; each one is checked against the policy account before anything moves, and
executes through Token-2022 Confidential Transfer, so a public observer sees a confirmed transaction
with no readable amount or balance. Whoever the owner authorizes can decrypt full detail, including
the agent's reasoning for the action.

## Stack
- **Chain:** Solana (devnet for the hackathon build)
- **On-chain privacy:** Solana Confidential Transfer (Token-2022 extension) — live, verified below
- **On-chain enforcement:** custom spend-policy program (native Solana program), deployed to devnet
- **Agent layer:** Solana Agent Kit
- **App:** Next.js + TypeScript

**Roadmap, explicitly not implemented:** delegate binding (making the policy program the token
account's actual delegate via a PDA + CPI, so an agent structurally cannot call Token-2022 without
going through policy) is designed but unbuilt — see `docs/PRIVACY_ARCHITECTURE.md` section 14 for
the design and, just as importantly, what it would and wouldn't solve. Arcium-based confidential
policy logic (hiding the limit values themselves) is a candidate for that same layer, evaluated but
not started. Neither is claimed as working; both are future work, not partially-shipped features.

## Verified on devnet

| | |
|---|---|
| Confidential transfer | [`5vTuKeoULGc…`](https://explorer.solana.com/tx/5vTuKeoULGc26FdNoxCVErWbYzet1jReDhgRqvp2Le9erDsWTx8p4P4VCGotC9mwFHaifazLeAbzq2mpCLwqAEtz?cluster=devnet) |
| Spend policy program | [`AmJYcUrs36n…`](https://explorer.solana.com/address/AmJYcUrs36nwpiEZxJDB5q49LbXypBVujNVMvKMWg19e?cluster=devnet) |
| Transferred amount readable on-chain | **No** — verified by reading the recipient account bytes |
| Agent's reasoning readable on-chain | **No** — encrypted, carried in a memo, verified by reading the raw transaction bytes back from devnet |

Re-run `npm run capture-proof` any time to re-verify both claims against a fresh transaction rather
than trusting a screenshot.

130 tests passing (120 TypeScript, 10 Rust).

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
