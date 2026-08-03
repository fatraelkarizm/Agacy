"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  Brain,
  Buildings,
  CursorClick,
  Eye,
  EyeSlash,
  FileText,
  PaperPlaneTilt,
  Pulse,
  ShieldCheck,
  UserCircle,
  Wallet,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletConnectionDTO } from "../server/dto/wallet.dto";
import { WalletGate } from "./WalletGate";
import {
  disconnectOwnerWallet,
  restoreOwnerWallet,
  watchOwnerWalletSession,
} from "../server/services/wallet-connection";

/**
 * `/` only ever shows the marketing landing page and the wallet-connect gate.
 * Once a wallet is connected, navigation moves to the real `/dashboard`
 * route (see app/dashboard/page.tsx) rather than an internal `stage` value —
 * a browser refresh needs the URL itself to say where the owner was, not a
 * piece of React state that resets to its initial value on every reload.
 */

type Stage = "intro" | "connect";

const LANDING_LINKS = [
  { id: "product", label: "Product" },
  { id: "how-it-works", label: "How it works" },
  { id: "onboarding", label: "Onboarding" },
  { id: "privacy-stack", label: "Privacy stack" },
] as const;

export default function Home() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("intro");
  const [ownerWallet, setOwnerWallet] = useState<WalletConnectionDTO | null>(null);
  const [restoringWallet, setRestoringWallet] = useState(true);

  const invalidateWallet = useCallback(() => {
    setOwnerWallet(null);
    setStage("connect");
  }, []);

  useEffect(() => {
    let active = true;
    void restoreOwnerWallet().then((wallet) => {
      if (active) setOwnerWallet(wallet);
    }).finally(() => {
      if (active) setRestoringWallet(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!ownerWallet) return;
    return watchOwnerWalletSession(ownerWallet.provider, invalidateWallet);
  }, [invalidateWallet, ownerWallet]);

  const disconnect = useCallback(async () => {
    if (!ownerWallet) return;
    try {
      await disconnectOwnerWallet(ownerWallet.provider);
    } finally {
      invalidateWallet();
    }
  }, [invalidateWallet, ownerWallet]);

  const enterDashboard = useCallback(() => {
    if (!ownerWallet) {
      setStage("connect");
      return;
    }
    router.push("/dashboard");
  }, [ownerWallet, router]);

  const showLandingSection = useCallback((sectionId: string) => {
    setStage("intro");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView());
    });
  }, []);

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <button
            className="brand"
            onClick={() => showLandingSection("product")}
            aria-label="Agacy home"
          >
            <span className="brand-mark" />
            Agacy
          </button>
          <div className="nav-links" aria-label="Landing page sections">
            {LANDING_LINKS.map((link) => (
              <button key={link.id} onClick={() => showLandingSection(link.id)}>
                {link.label}
              </button>
            ))}
            <a href="/docs">
              <FileText aria-hidden="true" size={14} weight="duotone" />
              Docs
            </a>
          </div>
          <div className="nav-actions">
            {ownerWallet && (
              <button className="nav-disconnect" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
            <button
              className="primary nav-launch"
              onClick={enterDashboard}
              disabled={restoringWallet}
            >
              {!restoringWallet && !ownerWallet && (
                <Wallet aria-hidden="true" size={17} weight="duotone" />
              )}
              {restoringWallet
                ? "Checking wallet..."
                : ownerWallet
                  ? shortAddress(ownerWallet.address)
                  : "Connect wallet"}
            </button>
          </div>
        </div>
      </nav>

      {stage === "intro" && <Intro onStart={enterDashboard} onProof={() => router.push("/proof")} />}

      {stage === "connect" && (
        <div className="wrap step-page wallet-page">
          <div className="step-head">
            <div className="step-index">Owner wallet</div>
            <h2>Connect before creating an agent.</h2>
            <p className="section-sub">
              Your wallet remains the root authority for policy, recovery, and revocation. The
              agent receives separate scoped permission later.
            </p>
          </div>
          <WalletGate
            onConnected={(wallet) => {
              setOwnerWallet(wallet);
              router.push("/dashboard");
            }}
          />
        </div>
      )}

      <footer className="foot">
        <div className="wrap">
          The blocked payment is not the model changing its mind. The agent still proposes it.
          The spend policy is enforced outside the model, so a prompt-injected or malfunctioning
          agent cannot talk its way past it. Amounts are hidden by Solana&apos;s native Token-2022
          confidential transfers.
        </div>
      </footer>
    </>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function Intro({ onStart, onProof }: { onStart: () => void; onProof: () => void }) {
  return (
    <main className="landing">
      <section className="hero" id="product">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="hero-eyebrow">Confidential agent wallet on Solana</p>
            <h1>
              <span className="hero-line">Autonomous money.</span>
              <span className="accent hero-line">Private by default.</span>
            </h1>
            <p className="lede">
              Agacy lets AI agents transact on Solana while balances, amounts, and policies stay
              encrypted on-chain.
            </p>
            <div className="hero-cta">
              <button className="primary" onClick={onStart}>
                Launch demo
              </button>
              <button className="text-button" onClick={onProof}>
                View proof <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>

          <HeroVideo />

          <section className="hero-proof" aria-label="Agacy privacy proof">
            <div className="proof-public">
              <p className="proof-kicker">Public view</p>
              <h2>Confirmed, not exposed.</h2>
              <p>Anyone can verify the transaction. The amount and resulting balance stay hidden.</p>
              <code>amount: ••••••</code>
            </div>

            <div className="proof-authorized">
              <p className="proof-kicker">Authorized view</p>
              <p className="owner-amount">12.5 USDC</p>
              <p>Owner-only detail and agent reasoning.</p>
            </div>

            <div className="proof-rail" aria-label="Verified technology">
              <div>
                <strong>Token-2022</strong>
                <span>Confidential transfers</span>
              </div>
              <div>
                <strong>ZK proofs</strong>
                <span>Protocol validation</span>
              </div>
              <div>
                <strong>Devnet verified</strong>
                <span>Real transaction</span>
              </div>
            </div>
          </section>
        </div>
      </section>

      <section className="landing-section exposure-section">
        <div className="wrap exposure-bento">
          <div className="section-copy exposure-intro">
            <EyeSlash className="bento-ghost-icon" aria-hidden="true" weight="duotone" />
            <h2>A public ledger becomes an intelligence feed.</h2>
            <p>
              Continuous agent activity exposes balances, spending patterns, and business
              relationships to anyone watching the chain.
            </p>
          </div>
          <article className="exposure-cell exposure-personal">
            <UserCircle aria-hidden="true" size={31} weight="duotone" />
            <div>
              <h3>Personal wallets</h3>
              <p>Visible balances make owners easier to profile and target.</p>
            </div>
          </article>
          <article className="exposure-cell exposure-business">
            <Buildings aria-hidden="true" size={29} weight="duotone" />
            <div>
              <h3>Business agents</h3>
              <p>History can reveal suppliers, revenue signals, and strategy.</p>
            </div>
          </article>
          <article className="exposure-cell exposure-always-on">
            <Pulse aria-hidden="true" size={29} weight="duotone" />
            <div>
              <h3>Always-on activity</h3>
              <p>Every autonomous action adds searchable financial data.</p>
            </div>
          </article>
        </div>
      </section>

      <section className="landing-section boundary-section" id="how-it-works">
        <div className="wrap boundary-bento">
          <div className="section-copy boundary-intro">
            <ShieldCheck className="bento-ghost-icon" aria-hidden="true" weight="duotone" />
            <h2>Autonomy needs a boundary outside the model.</h2>
            <p>
              The agent may propose a payment. Agacy checks policy before funds move, so a prompt
              cannot negotiate past the account limits.
            </p>
          </div>
          <article className="sequence-cell sequence-observe">
            <Eye aria-hidden="true" size={27} weight="duotone" />
            <strong>Observe</strong>
            <span>Read the task</span>
          </article>
          <article className="sequence-cell sequence-reason">
            <Brain aria-hidden="true" size={27} weight="duotone" />
            <strong>Reason</strong>
            <span>Choose an action</span>
          </article>
          <article className="sequence-cell sequence-decide">
            <CursorClick aria-hidden="true" size={27} weight="duotone" />
            <strong>Decide</strong>
            <span>Propose payment</span>
          </article>
          <article className="sequence-cell sequence-policy">
            <ShieldCheck aria-hidden="true" size={27} weight="duotone" />
            <strong>Policy check</strong>
            <span>Enforce owner limits</span>
          </article>
          <article className="sequence-cell sequence-execute">
            <PaperPlaneTilt aria-hidden="true" size={29} weight="duotone" />
            <div>
              <strong>Execute</strong>
              <span>Transfer privately only after policy approval.</span>
            </div>
          </article>
        </div>
      </section>

      <section className="landing-section onboarding-section" id="onboarding">
        <div className="wrap onboarding-overview">
          <div className="section-copy">
            <h2>From wallet connection to bounded autonomy.</h2>
            <p>
              The owner establishes control first. Agent authority is introduced gradually and
              reviewed before anything can execute.
            </p>
          </div>
          <ol className="onboarding-journey">
            <li>
              <span>01</span>
              <div>
                <strong>Connect owner wallet</strong>
                <p>Phantom or Solflare becomes the root authority.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Define the agent</strong>
                <p>Name its job and choose the operating purpose.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Set spending policy</strong>
                <p>Cap each transfer and the total period budget.</p>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>Choose privacy access</strong>
                <p>Keep owner detail separate from public metadata.</p>
              </div>
            </li>
            <li>
              <span>05</span>
              <div>
                <strong>Review and authorize</strong>
                <p>The owner approves scoped authority before the run.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section className="landing-section stack-section" id="privacy-stack">
        <div className="wrap privacy-bento">
          <div className="bento-visual">
            <Image
              src="/agacy-privacy-primitives-3d.png"
              alt="Three-dimensional encrypted vault, zero-knowledge prism, and policy gate"
              fill
              sizes="(max-width: 760px) 100vw, 58vw"
            />
          </div>
          <div className="bento-intro">
            <p className="proof-kicker">Solana-native privacy</p>
            <h2>Privacy where value moves.</h2>
            <p>
              Agacy uses protocol-level primitives instead of routing agents through a separate
              privacy network.
            </p>
          </div>
          <article className="bento-detail bento-token">
            <strong>Token-2022</strong>
            <span>Encrypted balances and transfer amounts stay native to Solana.</span>
          </article>
          <article className="bento-detail bento-zk">
            <strong>ZK proofs</strong>
            <span>Transfers prove validity without exposing their size.</span>
          </article>
          <article className="bento-detail bento-policy">
            <strong>Policy gate</strong>
            <span>
              Spend limits live outside the agent prompt — encrypted, and enforced by a program that
              never reads them.
            </span>
          </article>
        </div>
      </section>

      <section className="landing-cta">
        <div className="wrap landing-cta-inner">
          <h2>Let the agent act.<br />Keep the ledger quiet.</h2>
          <button className="primary" onClick={onStart}>Launch demo</button>
        </div>
      </section>
    </main>
  );
}

function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPlayback = () => {
      if (motionPreference.matches) videoRef.current?.pause();
      else void videoRef.current?.play().catch(() => undefined);
    };

    syncPlayback();
    motionPreference.addEventListener("change", syncPlayback);
    return () => motionPreference.removeEventListener("change", syncPlayback);
  }, []);

  return (
    <div className="hero-media">
      <video
        ref={videoRef}
        muted
        loop
        playsInline
        preload="metadata"
        poster="/agacy-encrypted-core.png"
        aria-label="Encrypted transaction paths moving through a protected vault core"
      >
        <source src="/agacy-private-core.mp4" type="video/mp4" />
      </video>
    </div>
  );
}
