import Link from "next/link";

const DEMO_STEPS = [
  ["01", "Connect owner wallet", "Phantom or Solflare establishes the root authority."],
  ["02", "Define the agent", "Choose its purpose and a recognizable owner-facing name."],
  ["03", "Set spending policy", "Limit every transfer, total spend, and policy period."],
  ["04", "Choose privacy access", "Separate public metadata from owner-authorized detail."],
  ["05", "Review and authorize", "Inspect the scope before creating agent authority."],
] as const;

export default function DocsPage() {
  return (
    <main className="docs-page">
      <nav className="docs-nav">
        <Link className="brand" href="/" aria-label="Agacy home">
          <span className="brand-mark" />
          Agacy
        </Link>
        <Link href="/">Back to product</Link>
      </nav>

      <div className="wrap docs-layout">
        <aside className="docs-toc" aria-label="Documentation sections">
          <p>Documentation</p>
          <a href="#overview">Overview</a>
          <a href="#demo-flow">Demo flow</a>
          <a href="#privacy">Privacy guarantees</a>
          <a href="#stack">Verified stack</a>
          <a href="#boundaries">Security boundaries</a>
        </aside>

        <article className="docs-content">
          <header className="docs-hero" id="overview">
            <p className="proof-kicker">Agacy docs / Devnet demo</p>
            <h1>Confidential infrastructure for autonomous payments.</h1>
            <p>
              Agacy gives an AI agent scoped payment authority while its owner remains the root of
              policy, recovery, and revocation.
            </p>
          </header>

          <section id="demo-flow">
            <p className="docs-index">01 / Demo flow</p>
            <h2>Owner first. Agent second.</h2>
            <div className="docs-flow">
              {DEMO_STEPS.map(([number, title, description]) => (
                <div key={number}>
                  <span>{number}</span>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="privacy">
            <p className="docs-index">02 / Privacy guarantees</p>
            <h2>What is private today.</h2>
            <div className="docs-callout">
              <strong>Current devnet scope</strong>
              <p>
                Token-2022 confidential transfers hide token amounts and resulting balances while
                preserving verifiable transaction validity. Account addresses remain visible.
              </p>
            </div>
            <p>
              Full address unlinkability belongs to the planned shielded execution layer. The demo
              does not label that future property as shipped.
            </p>
          </section>

          <section id="stack">
            <p className="docs-index">03 / Verified stack</p>
            <h2>Built around Solana-native primitives.</h2>
            <dl className="docs-facts">
              <div><dt>Network</dt><dd>Solana devnet</dd></div>
              <div><dt>Asset privacy</dt><dd>Token-2022 confidential transfers</dd></div>
              <div><dt>Validation</dt><dd>Zero-knowledge proofs</dd></div>
              <div><dt>Control</dt><dd>Policy checks outside the model prompt</dd></div>
            </dl>
          </section>

          <section id="boundaries">
            <p className="docs-index">04 / Security boundaries</p>
            <h2>Separation is the safety property.</h2>
            <ul className="docs-boundaries">
              <li>Agacy never requests a seed phrase or private key.</li>
              <li>The connected wallet remains the owner and recovery authority.</li>
              <li>Agent authority is separately scoped and can be revoked.</li>
              <li>Public and authorized transaction data use distinct application types.</li>
            </ul>
          </section>
        </article>
      </div>
    </main>
  );
}
