<div align="center">

# 🛡️ Agacy

### Private execution for autonomous agents on Solana

Give an AI agent a goal—not unrestricted access to your wallet.

[![NTU InnovateX 2026](https://img.shields.io/badge/NTU_InnovateX_2026-Track_2-7C5CFC?style=for-the-badge)](https://ntu-cctf-snz-innovatex-2026.devpost.com/)
[![Solana Devnet](https://img.shields.io/badge/Solana-Devnet-14F195?style=for-the-badge&logo=solana&logoColor=black)](https://explorer.solana.com/?cluster=devnet)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js)

</div>

![Agacy privacy flow: public agent wallet compared with confidential policy-bound execution](public/agacy-privacy-compare-flow.svg)

## 📋 Project Details

| Devpost field | Submission |
|---|---|
| **Project title** | Agacy |
| **Selected track** | Track 2 — Web3 Applications, AI Agents and Real-World Use Cases |
| **Team type** | Student Group |
| **Prototype status** | Functional prototype on Solana devnet |
| **Short description** | Agacy is a confidential wallet and execution layer for autonomous AI agents. Owners delegate goals and bounded spending authority; the agent chooses how to act while encrypted, on-chain policy prevents it from exceeding its mandate. |

> **The model decides what to do. The policy decides what it is allowed to do.**

## 🎯 Project Overview

### The problem

AI agents are beginning to pay for APIs, infrastructure, datasets, suppliers, subscriptions, and
other agents. The wallet infrastructure beneath them still has two dangerous defaults:

1. **Their financial activity is public.** Once an agent wallet is linked to a company, DAO, or
   person, observers can profile balances, payment amounts, supplier relationships, operating
   cadence, and treasury runway.
2. **Their spending policy is often only a prompt.** A system instruction such as “never spend more
   than 20 USDC” is guidance to the model, not a security boundary. Prompt injection, faulty
   reasoning, or concurrent tool calls can cause the agent to ignore it.

This creates a bad choice for an owner: approve every payment manually and lose the value of
autonomy, or give an agent a visible wallet with authority that is too broad.

### The proposed solution

**Agacy separates intelligence from authority.** The owner gives an AI agent a natural-language
goal and a bounded spending mandate. The agent can inspect its environment, select tools, branch
into subtasks, and replan autonomously—but every value-moving action must pass an owner-controlled
policy enforced outside the model.

Approved payments use Token-2022 Confidential Transfer. Amounts and balances stay encrypted,
policy limits can be enforced without being published as plaintext, and agent reasoning is stored
as encrypted audit data. The public sees a verifiable transaction; the authorized owner retains the
details needed to understand and audit it.

### Why Agacy

Privacy alone does not make an agent safe, and a spend limit alone does not make it private. Agacy
combines the controls that a production agent wallet needs in one execution path:

| Approach | Autonomous | Financial data confidential | Limit outside the model | Owner audit |
|---|:---:|:---:|:---:|:---:|
| Manual wallet approval | ❌ | ❌ | ✅ | ✅ |
| Ordinary agent wallet | ✅ | ❌ | ❌ | ✅ |
| Model-only spending rule | ✅ | ❌ | ❌ | ✅ |
| **Agacy** | ✅ | ✅ | ✅ | ✅ |

The result is not another chatbot or wallet dashboard. Agacy is the **privacy and authority layer
between an AI agent's decisions and the owner's funds**.

### Key features

- 🕸️ **Live autonomous execution graph** — one owner command becomes a recursive graph of model-
  selected observations, tool calls, policy checks, merged results, replanning, and honest refusal.
- 🔐 **Confidential payments** — Token-2022 Confidential Transfer hides transfer amounts and
  confidential balances using Solana's ZK proof infrastructure.
- ⛓️ **Encrypted on-chain spending policy** — per-transfer and rolling-period limits are enforced by
  a deployed program, not negotiated with the model.
- 🧾 **Private reasoning audit trail** — concise agent reasoning is encrypted with AES-GCM and
  carried as ciphertext in an SPL Memo.
- 👁️ **Structurally separate views** — public and authorized transaction DTOs are different types;
  public UI code cannot accidentally receive decrypted fields.
- 🧪 **Adversarial proof** — over-limit, amount-mismatch, replay, unauthorized CPI, and custody-
  seizure attempts are tested against the real devnet program.
- 🔑 **Owner recovery** — the owner can take custody back without depending on the agent's budget
  or cooperation.

## 👥 Target Users and Scale

### Initial users

| User | What they delegate | Why Agacy matters to them |
|---|---|---|
| **DAO treasury operators and multisig signers** | Contributor payouts, grants, infrastructure, recurring operations | They need bounded automation without exposing runway, recipient amounts, or payment cadence to competitors and attackers. |
| **Startup and SME finance/procurement teams** | Supplier invoices, SaaS renewals, API credits, cloud and compute purchases | Public payments can reveal supplier pricing, vendor relationships, and operating velocity; manual approval does not scale with frequent small purchases. |
| **Web3 protocols and agent platforms** | Keeper costs, data feeds, compute, settlement, and agent-to-agent services | An always-on agent needs machine-speed payments, but the protocol still needs cryptographic limits and an owner-readable audit trail. |
| **Individual power users** | Subscriptions, trading tools, data purchases, and personal automation | They want delegation without publishing a permanent financial profile or giving a model unlimited authority. |

### Scale path

Agacy starts with a narrow, high-value workflow: **a procurement or treasury agent making bounded
confidential payments**. The same execution boundary can then protect multiple agents across one
organization, reusable payment tools across agent platforms, and eventually any AI workflow that
can request an on-chain transaction.

The scalable product is not one specialized procurement bot. It is a wallet-level policy and
privacy layer that different agents can use while owners keep control. Broader tool and MCP
integration is an expansion path after the core confidential-payment guarantee is production-ready,
not a dependency for this hackathon prototype.

## 🔄 How the Product Works

```mermaid
flowchart LR
    O[👤 Owner defines goal and limits] --> A((🧠 AI Agent))
    A --> G[🕸️ Observe, choose tools, replan]
    G --> P{🛡️ On-chain policy}
    P -->|Within mandate| T[🔐 Confidential execution]
    P -->|Outside mandate| R[⛔ Reject]
    T --> PUB[🌍 Redacted public view]
    T --> AUTH[🔑 Decrypted owner audit]
```

1. The owner connects a Solana devnet wallet.
2. The owner names the agent, chooses its purpose, and sets per-transfer and period limits.
3. Agacy provisions a policy account that the agent cannot modify.
4. The owner gives the agent a goal in natural language.
5. The agent expands the goal into an observable execution graph and calls verified tools.
6. Every spend is evaluated against the policy path before execution.
7. The public sees redacted transaction data; the owner can inspect decrypted detail and reasoning.

### Example agent graph

```mermaid
flowchart LR
    C[Owner command] --> A((AI Agent))
    A --> W[Read wallet]
    A --> P[Check on-chain policy]
    W --> WR[Wallet result]
    P --> PR[Policy result]
    WR --> V{Verified observations}
    PR --> V
    V --> D[Reason and replan]
    D -->|Allowed| X[Authorize]
    D -->|Outside policy| B[Blocked]
```

This is a live execution DAG—not a decorative blockchain diagram. Nodes are generated from the
owner's goal, and tool-result nodes are created only after the runtime has executed and verified the
corresponding tool.

## 🔎 What Privacy Looks Like

| Data | 🌍 Public observer | 🔑 Authorized owner |
|---|:---:|:---:|
| Transaction exists | ✅ | ✅ |
| Transfer amount | 🔒 Hidden | ✅ Decrypted |
| Confidential balance | 🔒 Hidden | ✅ Decrypted |
| Agent reasoning | 🔒 Ciphertext only | ✅ Decrypted |
| Spend-policy limits | 🔒 Encrypted | ✅ Available |
| Timing, fees, and program interaction | ⚠️ Visible | ✅ Visible |

Agacy is **confidential, not magically anonymous**. The current prototype does not claim to hide
timing, fees, program interaction, or every form of address linkability.

## 🏗️ Technical Architecture

```mermaid
flowchart TD
    UI[Presentation · public / owner / graph] --> S[Service · orchestration and policy decisions]
    S --> D[Data · Solana RPC, proofs, encryption, agent tools]
    D --> P[Agacy policy program · Solana devnet]
    P -->|Policy satisfied| T[Token-2022 Confidential Transfer]
    P -->|Policy violated| R[Reject on-chain]
    T --> PUB[PublicTransactionDTO · no private fields]
    T --> AUTH[AuthorizedTransactionDTO · owner-only detail]
```

### Technologies

| Layer | Technology | Role |
|---|---|---|
| Blockchain | Solana devnet | Settlement, policy state, and verifiable program execution |
| Confidentiality | Token-2022 Confidential Transfer, `@solana/zk-sdk`, ZK ElGamal Proof program | Encrypt amounts/balances and verify transfer proofs |
| Policy | Rust + Anchor program with PDA-owned custody | Enforce spend limits and restrict the signing path |
| Agent | Solana Agent Kit, Vercel AI SDK, OpenAI-compatible model | Goal-driven tool selection and recursive graph expansion |
| Application | Next.js 15, React 19, TypeScript, `@solana/kit` | Owner onboarding, public/authorized views, and graph UI |
| Audit encryption | AES-GCM via Web Crypto + SPL Memo | Store reasoning ciphertext for owner-authorized review |

## ✅ Supporting Materials and Devnet Evidence

| Material | What it demonstrates |
|---|---|
| [Privacy comparison diagram](public/agacy-privacy-compare-flow.svg) | Ordinary public agent wallet versus Agacy's confidential, policy-bound path |
| [Encrypted-core visual](public/agacy-encrypted-core.png) | Product privacy model and protected data boundary |
| [Prototype demo clip](public/agacy-private-core.mp4) | Current application concept and interaction direction |
| Embedded architecture diagrams above | Agent, policy, Token-2022, and public/authorized data flow |
| [Confidential transfer on devnet](https://explorer.solana.com/tx/5vTuKeoULGc26FdNoxCVErWbYzet1jReDhgRqvp2Le9erDsWTx8p4P4VCGotC9mwFHaifazLeAbzq2mpCLwqAEtz?cluster=devnet) | Real Token-2022 confidential transfer |
| [Deployed spend-policy program](https://explorer.solana.com/address/9sYKkYh1GTKY2whkGPGXuG1VKiYqfiwyjVcpQbYtHtwW?cluster=devnet) | Policy account and program execution on Solana devnet |

Reproduce the security claims instead of trusting screenshots:

```bash
npm run capture-proof
npm run verify-custody
npm run verify-confidential-limits
npm run verify-attacks
```

Verified behaviors include a real confidential payment signed through program-owned custody,
rejection of an over-limit spend, rejection of a valid `claim 1 / transfer 25` proof mismatch, and
owner recovery of the custodied account.

## 🚀 Run the Application

### Prerequisites

- Node.js 22 or newer and npm.
- A Solana browser wallet configured for devnet.
- Devnet SOL for policy provisioning and live transactions.
- An OpenAI-compatible API key for the model-generated Agent Graph.

### 1. Install

```bash
git clone https://github.com/fatraelkarizm/Agacy.git
cd Agacy
npm install
```

### 2. Configure

```bash
cp .env.example .env.local
# Windows PowerShell: Copy-Item .env.example .env.local
```

Set `LLM_API_KEY` in `.env.local`. `BASE_URL` and `LLM_MODEL` let you use another
OpenAI-compatible endpoint and model. The public Solana devnet endpoints work by default; a private
RPC is recommended for repeated live verification.

### 3. Start

```bash
npm run dev
```

Open `http://localhost:3000` and follow this demo path:

1. Connect the owner wallet.
2. Create an agent and choose a purpose such as **Procurement**.
3. Set the spending policy and choose **Confidential** visibility.
4. Review and sign the devnet policy-account transaction.
5. Open **Agent Graph**, click the central **AI Agent** node—or right-click the canvas—and enter a
   natural-language command.
6. Watch wallet and policy reads branch, merge into verified observations, and continue to an
   authorization or refusal.
7. Use the dashboard's public/owner comparison and attack controls to explain the privacy and
   enforcement guarantees.

### 4. Verify

```bash
npm test
npm run typecheck
npm run build
```

The standalone autonomous devnet flow is available through `npm run agent`. It provisions a fresh
confidential environment and lets the model choose tools against real devnet state.

## 👤 Team Details

| Member | Role | Affiliation |
|---|---|---|
| [Fatra Al Khawarizmi](https://github.com/fatraelkarizm) | Project Lead · Product · Full-stack, AI Agent and Solana Engineering | Universitas Pendidikan Indonesia |

- **Team:** Agacy
- **Team type:** Student Group
- **Location:** Bandung, Indonesia
- **Student verification:** proof of current enrollment should be uploaded privately through the
  Devpost submission, not committed to this public repository.

## 🏆 InnovateX Judging Fit

| Official criterion | Weight | Agacy's evidence |
|---|:---:|---|
| Technical Quality | **30%** | Working devnet program, confidential transfers, adversarial verification, typed privacy boundary, automated tests |
| Real-World Impact | **25%** | Safe delegation for treasury, procurement, protocol, and personal payment agents |
| Innovation | **20%** | Confidential agent intent plus encrypted, on-chain-enforced spending limits |
| Demo and Presentation | **15%** | One visual execution graph and a side-by-side public/owner privacy reveal |
| Track Relevance | **10%** | Autonomous, user-facing Web3 agent infrastructure solving a concrete financial-control problem |

Criteria source: [NTU InnovateX Hackathon 2026 on Devpost](https://ntu-cctf-snz-innovatex-2026.devpost.com/).

## 🧭 Deliberate Hackathon Scope

The prototype focuses on one defensible loop:

**owner goal → autonomous decision → confidential payment → on-chain enforcement → owner audit**

Multi-chain support, a general MCP marketplace, public identity/reputation, lending, and a general-
purpose multi-agent platform are intentionally outside the Stage 1 scope. They do not make the core
privacy and policy claim stronger.

---

<div align="center">

**Autonomy without unlimited authority. Privacy without unverifiable promises.**

Built for NTU InnovateX Hackathon 2026.

</div>
