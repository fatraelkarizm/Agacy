# AGENTS.md — Agacy

Entry-point instructions for any coding agent working in this repo (Claude Code, Codex, Cursor, or otherwise). Read this before making changes.

## What this project is
Agacy — Agentic Privacy for AI Agents. A confidential AI agent wallet on Solana. See `docs/PRD.md` for the full product spec, `docs/FEATURES.md` for current build status, `docs/INFRASTRUCTURE.md` for the stack, `docs/PRIVACY_ARCHITECTURE.md` for the parent-owned shielded target, and `docs/ARCHITECTURE.md` for code-structure rules — **read `docs/ARCHITECTURE.md` before writing any code in this repo, its layering/DTO rules are non-negotiable.**

## Installed skills
This repo has agent skills installed under `.agents/skills/` (installed via `npx skills add`, universal across Claude Code/Codex/Cursor/etc.). Use them proactively when relevant, don't wait to be asked by name:

| Skill | Use when |
|---|---|
| `design-taste-frontend`, `design-taste-frontend-v1` | Building or reviewing any UI screen — apply before shipping frontend work, not after. |
| `high-end-visual-design`, `minimalist-ui`, `industrial-brutalist-ui` | Choosing a visual direction for the demo UI (public/authorized views) — pick one style and apply consistently rather than mixing. |
| `brandkit` | Anything touching the Agacy name/logo/visual identity. |
| `stitch-design-taste`, `gpt-taste` | General taste/quality pass on generated UI or copy. |
| `image-to-code` | Converting a design mock/screenshot into actual component code. |
| `imagegen-frontend-web`, `imagegen-frontend-mobile` | Generating imagery/assets for the web or mobile demo surfaces. |
| `redesign-existing-projects` | Revisiting/improving UI once a first pass already exists — not for greenfield work. |
| `full-output-enforcement` | Ensure generated code/content isn't silently truncated — apply when producing large files. |
| `ponytail` | **Active on every coding response by default.** Forces the simplest solution that works (YAGNI, stdlib/native before deps, shortest diff) — see "Ponytail vs. ARCHITECTURE.md" below for how this interacts with the DTO/layering rules. |
| `ponytail-review` | Diff-scoped review that only hunts over-engineering (reinvented stdlib, unneeded deps, speculative abstractions) — run before committing non-trivial changes. |
| `ponytail-audit` | Whole-repo sweep for bloat/over-engineering — run periodically, not per-commit; one-shot report, doesn't apply fixes. |
| `ponytail-debt` | Collects every `ponytail:` comment (deliberate shortcuts) into a debt ledger — run before Stage 1 submission to make sure known corners cut are visible, not forgotten. |
| `ponytail-gain`, `ponytail-help` | Scoreboard / quick-reference — informational only. |
| `ui-ux-pro-max` | Searchable design-rules database (styles, palettes, fonts, UX guidelines, motion, charts) across 22 stacks — use for concrete design-system decisions (colors, typography, layout) instead of guessing. ⚠️ Flagged High Risk by the Gen scanner on install; manual review of its bundled scripts found no network calls, subprocess/eval/exec, or obfuscation — looks like a generic "bundles executable code" heuristic, but treat with normal caution when running its `search.py`. |
| `banner-design`, `brand`, `design`, `design-system`, `ui-styling` | Supporting design skills from the same pack — narrower scope than `ui-ux-pro-max`, use when the task matches the name directly. |
| `slides` | Presentation/pitch-deck structure and copywriting — use when building the hackathon pitch deck. ⚠️ Flagged Med Risk by Gen/Snyk on install; it's plain markdown reference content with no executable code, so this looks like a scanner false positive, but noted here for visibility. |

Check each skill's own instructions (under `.agents/skills/<name>/`) for specifics before invoking.

### Ponytail vs. `docs/ARCHITECTURE.md` — not a conflict
Ponytail forbids *unrequested* abstraction ("no interface with one implementation," "no unneeded layering"). The DTO/layering split in `docs/ARCHITECTURE.md` is a **deliberate, explicitly-requested** architectural decision for this project — specifically because the public/private data boundary is the product's core safety property, not incidental structure. Ponytail should keep everything else (helper functions, error handling, script structure, dependency choices) as minimal as possible, but the layer boundary and the two distinct transaction DTOs stay non-negotiable regardless of ponytail's intensity level.

## Hard rules (see docs/ARCHITECTURE.md for full detail)
1. Data layer, service/business-logic layer, and presentation layer stay separate — no Solana RPC or decryption calls inside UI components, no business rules inside data-fetching code.
2. Cross-layer data only moves as DTOs (`/server/dto`), never raw SDK types.
3. `PublicTransactionDTO` and `AuthorizedTransactionDTO` are distinct types — never merge them into one object with a "hide this" flag. The public/private boundary must be enforced by the type system, not by UI logic remembering to hide a field.
4. Keep contracts out of logic modules: shared interfaces/types/DTOs live in `/server/dto`,
   integration-only types in `/server/types`, and runtime validation schemas in `/server/schema`.
   Data, service, and agent logic import these contracts; component-local prop types may stay local.

## What NOT to do
- Do not copy code from `IsSlashy/Protocol-01` or any other proprietary/no-license repo — see `docs/references/03-competitive-landscape.md` for why Agacy's differentiation depends on this being original work.
- Do not add a public identity, reputation, or KYA registry — out of Stage 1 scope, see
  `docs/FEATURES.md`. Private ownership attestation is a distinct future privacy primitive defined
  in `docs/PRIVACY_ARCHITECTURE.md`; do not implement it before its shielded-state and key-custody
  decisions are resolved.
- Do not commit `docs/` to the public GitHub repo — it's gitignored intentionally (planning docs stay local).

## Where to look for context
- Product reasoning & evidence: `docs/references/`
- Current build status: `docs/FEATURES.md` (keep statuses updated as you work)
- Stack & build order: `docs/INFRASTRUCTURE.md`

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
