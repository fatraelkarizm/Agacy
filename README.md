# Agacy

**Agentic Privacy for AI Agents**

Built for NTU InnovateX Hackathon 2026 (NTU CCTF x SNZ).

## Project Overview

### The problem

AI agents already hold wallets and transact on-chain without a human approving each payment —
treasury bots, procurement agents, DAO-delegated spenders. On-chain agent activity has grown
sharply as rails like Coinbase's x402 scale to hundreds of millions of agent payments. Every one of
those payments is permanently public by default: anyone who links an agent's wallet to its owner —
a KYC'd on-ramp, an address posted once — can read its full balance and every payment it has ever
made. That is not theoretical; wallet-drainer losses reached roughly $500M in 2024, and phishing
losses have kept climbing even as victim counts fall, meaning attackers are already shifting from
spraying everyone to picking targets by reading balances first. An agent that transacts continuously
and predictably is easier to profile and target than a human's occasional activity. The second
default is just as bad: the only "spend limit" most agent wallets have today is a system-prompt
instruction, which a bug or a prompt injection can talk the agent out of — a limit that lives inside
the model's reasoning is not really a limit.

### The proposed solution

Agacy is a confidential AI agent wallet on Solana where **spend limits are a property of an
on-chain account, not a request to the model**, and the agent's balance, transfer amounts, and
decision reasoning stay encrypted — readable only by whoever the owner explicitly authorizes. It
combines three things, only one of which is a Solana primitive:

1. **Confidential balances and amounts** via Token-2022 Confidential Transfer — the rail, not the
   invention. A public observer sees a confirmed transaction and nothing about its size.
2. **A spend-policy program that makes limits structural, not requested.** A deployed on-chain
   program owns the policy account; the agent can only spend what the account allows, never what it
   claims it needs — verified by having the program itself act as the token account's delegate and
   reject an over-limit transfer even when the raw token-level approval would have permitted it.
3. **Encrypted reasoning, not just encrypted balances.** Confidential Transfer hides *how much*
   moved; it says nothing about *why*. Agacy encrypts the agent's plain-language reasoning and
   carries the ciphertext on-chain, so the audit trail for *why* an agent paid is as protected as
   the amount itself.

### Key features

- A genuinely autonomous agent: given a goal, not a script, it chooses its own tools and sequence
  and decides when it's done — proven live against real devnet transactions, including a run where
  it tried to satisfy a request beyond its budget by firing many rapid payment attempts, and the
  spend limit held exactly at its ceiling regardless of how it tried.
- Confidential transfers verified end-to-end on devnet (all three required ZK proofs: equality,
  ciphertext validity, range).
- An on-chain spend-policy program enforcing per-transfer and rolling-period limits, deployed to
  devnet, that the agent cannot self-modify or talk its way past.
- A delegate-binding mechanism proven to move real tokens on live devnet as a real SPL delegate,
  and to reject an over-limit transfer even when the raw delegate approval was set higher.
- Encrypted agent reasoning, carried on-chain and verified absent from the raw transaction bytes.
- A public/authorized view split enforced by the type system, not a UI toggle — a public view is
  structurally incapable of holding a decrypted amount.
- A narrated adversarial simulation (attacker or competitor scan) run against both an ordinary
  wallet and Agacy's side by side, live in the demo.

### Target users

- **DAO treasury committees / multisig signers** delegating a bounded budget to an agent that pays
  contributors, grants, or infrastructure vendors — need full audit access themselves while keeping
  treasury runway and payment cadence hidden from rival DAOs or opportunistic poachers reading
  on-chain history.
- **Startup or SME finance leads running a procurement agent** that pays suppliers or vendors — need
  to keep supplier pricing, spend velocity, and vendor relationships hidden from competitors who
  would otherwise infer deal terms or company runway from public wallet activity.
- **Individual power users delegating a personal trading or spending agent** — want automation
  without turning every transaction into permanently public data a stranger could use to profile or
  target them.

The onboarding flow's "Procurement" persona and the in-app attacker/competitor simulation model the
DAO/business scenario end to end; "Personal" framing models the individual case with the same
underlying mechanism.

### Technologies

- **Chain:** Solana (devnet for the hackathon build)
- **Confidential transfer:** Token-2022 Confidential Transfer, `@solana/zk-sdk`, ZK ElGamal Proof program
- **On-chain enforcement:** custom spend-policy program — native Rust (deployed) and an Anchor/PDA
  rewrite enabling delegate binding (deployed, litesvm-tested)
- **Encrypted reasoning:** AES-GCM (Web Crypto), carried on-chain via SPL Memo
- **Agent layer:** Solana Agent Kit, Vercel AI SDK for the autonomous tool-calling loop
- **App:** Next.js + TypeScript, `@solana/kit`

## Technical deep dive

The rest of this document goes deeper into what's actually built and how each claim above is
verified — not just asserted.

### What's actually original here

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
- **The policy program can be the token account's actual delegate, gating any CPI it forwards.**
  `authorize_and_invoke` checks policy, then signs for the policy PDA via `invoke_signed` to forward
  a transfer — proven in a simulated runtime (litesvm) by having it move real SPL tokens as a real
  delegate, and refuse a transfer over the policy's limit even when the raw SPL delegate approval
  was deliberately set higher. This is what makes the earlier "spend limits are unbypassable" claim
  structural rather than aspirational — see the caveat below on what it still doesn't prove.

### How it works

The owner connects a wallet and defines an agent with a spending policy (max per transfer, max per
period). Provisioning writes that policy to a real devnet account the agent cannot self-modify. The
agent proposes payments; each one is checked against the policy account before anything moves, and
executes through Token-2022 Confidential Transfer, so a public observer sees a confirmed transaction
with no readable amount or balance. Whoever the owner authorizes can decrypt full detail, including
the agent's reasoning for the action.

### The autonomous agent

Earlier versions of this demo ran a fixed list of tasks through a scripted decision — reproducible,
but closer to a bot following a script than an agent. The current agent is given a goal, not a
task list: it chooses which tools to call, in what order, and when it's satisfied, using a real
LLM through Solana Agent Kit's own tool-calling adapter.

The interesting part isn't that it can call tools — it's what happens when it's pushed past its
budget. Given a goal that exceeds its remaining spend for the period, the model didn't just fail
politely: it fired many rapid, sometimes concurrent payment attempts trying to satisfy the request
however it could. That's exactly the scenario a policy check needs to survive, and building it
surfaced a real concurrency bug in the guard — two payment attempts landing at nearly the same
moment could each pass the check before either was recorded as spent, which would have let them
collectively exceed the limit as a group even though each looked compliant on its own. Fixed, and
now covered by a regression test, the run holds exactly at the period ceiling regardless of how many
attempts the model throws at it, independently verified by decrypting the recipient's own on-chain
balance afterward — not by trusting the model's summary, which in testing confidently reported the
wrong total.

Every tool the model can reach that moves value is policy-gated the same way, by construction: a
tool is checked automatically once it declares what it spends, and a tool that moves money without
declaring it fails an explicit check before it can ship at all — the same "not a request to the
model" principle as the rest of Agacy, now extended to an open-ended toolset instead of one hardcoded
action.

### Delegate binding

**Compiled, deployed, and proven live on devnet with real token movement — not just simulation.**
The policy program is deployed at [`783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G`](https://explorer.solana.com/address/783Eojkn9uMHtNCiM6yiTecRrdddFM7xEiwBu7Sxxm1G?cluster=devnet)
and set up as a real token account's delegate, then made to actually forward a transfer on the
policy's behalf: an in-policy call moved real tokens between real devnet accounts, and an over-limit
call was rejected by the running program even though the raw token-level approval alone would have
allowed it — a genuine bypass attempt against a live program on a real cluster, and it fails to
bypass. What this does and doesn't prove, precisely: it closes the *structural* bypass (an agent
cannot spend without the policy check succeeding first, because it holds no other authority). It
does **not** close the *confidential-amount-claim* gap — the program still cannot verify a
caller-claimed amount matches an encrypted transfer's real value, which is why this proof uses
classic SPL Token rather than Token-2022 confidential transfer specifically (that needs ZK
proof-context accounts this mechanism doesn't forward yet). And it is **not yet wired into the app
itself** — real onboarding still provisions through the original policy program, so this
delegate-binding mechanism is proven standalone, not yet live in the product. Arcium-based
confidential policy logic (hiding the limit values themselves) is a separate, unstarted candidate
for the same layer.

### Verified on devnet

| | |
|---|---|
| Confidential transfer | [`5vTuKeoULGc…`](https://explorer.solana.com/tx/5vTuKeoULGc26FdNoxCVErWbYzet1jReDhgRqvp2Le9erDsWTx8p4P4VCGotC9mwFHaifazLeAbzq2mpCLwqAEtz?cluster=devnet) |
| Spend policy program | [`AmJYcUrs36n…`](https://explorer.solana.com/address/AmJYcUrs36nwpiEZxJDB5q49LbXypBVujNVMvKMWg19e?cluster=devnet) |
| Transferred amount readable on-chain | **No** — verified by reading the recipient account bytes |
| Agent's reasoning readable on-chain | **No** — encrypted, carried in a memo, verified by reading the raw transaction bytes back from devnet |

Re-run `npm run capture-proof` any time to re-verify both claims against a fresh transaction rather
than trusting a screenshot.

## Run it

```bash
npm install
npm run dev                    # landing page + live agent demo
npm test                       # unit tests
npm run test:integration       # devnet round trip (needs AGACY_RPC_URL)
npm run capture-proof          # re-record the on-chain evidence
npm run verify-delegate-binding # re-verify delegate binding against a fresh devnet transfer
npm run agent                  # run the autonomous agent against real devnet (needs LLM_API_KEY)
```
