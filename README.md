# Chatbot demo

Live demo: OpenAI side-by-side comparison grounded in the [Axiom rules engine](https://github.com/TheAxiomFoundation/axiom-rules-engine). The app is fully **catalog-driven**: it can answer questions and run calculations for every program certified in the pinned [rulespec-us](https://github.com/TheAxiomFoundation/rulespec-us) `program-artifacts` release — currently 32 programs across 23 US jurisdictions (SNAP, TANF, federal individual income tax, state income tax, payroll, and more).

No model-recall numbers on the grounded side: every dollar amount comes from an `axiom-rules-engine` compute against sha256-verified compiled artifacts.

## How it works

Everything hangs off one pin, `artifacts.lock.json`:

```
artifacts.lock.json ──▶ scripts/fetch-artifacts.ts ──▶ engine/artifacts/*.compiled.json  (gitignored, sha256-verified)
                    ──▶ scripts/generate-catalog.ts ──▶ src/lib/generated/catalog.json   (committed)
                    ──▶ modal_app.py                 ──▶ Modal-hosted engine image
```

- **`scripts/generate-catalog.ts`** walks every compiled artifact's IR to derive, per program: all queryable outputs (with legal ids and units), every input slot the rules reach (grouped by entity, with inferred dtypes and defaults), relations with related-entity inference, and `acknowledged_incomplete` flags from the program specs. No per-program code anywhere.
- **`src/lib/request-builder.ts`** turns catalog metadata + user facts into a complete engine request (defaults for every unspecified slot, one member instance per household member, relation tuples, queries grouped by period grain).
- **`src/lib/tools.ts`** exposes five generic tools to the LLM: `list_programs`, `describe_program`, `compute`, `lookup_value`, `fetch_citation`. Unknown slot/output names return structured errors with nearest-match suggestions so the model self-corrects.
- **`/programs`** is a static coverage browser generated from the catalog — certified outputs, incomplete flags, input slots, and links to the spec at the pinned corpus sha.

## Stack

| Layer | What |
|---|---|
| Chat UI | Next.js 15 App Router + AI SDK (`ai` + `@ai-sdk/openai` + `@ai-sdk/react`) |
| Engine | `axiom-rules-engine` Rust binary, Modal-hosted in production or spawned locally |
| Rules content | Compiled artifacts from the pinned `rulespec-us` GitHub release (no repo cloning, no local compilation) |
| Citations | `axiom-foundation.org/api/axiom/documents/...` + app.axiom-foundation.org legal links |

## Setup

You need Rust + Node or Bun.

```bash
# 1. Build the engine binary at the pinned ref + fetch release artifacts
bun run engine:setup

# 2. Install web deps
bun install

# 3. Add your OpenAI key
cp .env.example .env.local        # set OPENAI_API_KEY

# 4. Verify the engine paths
bun run test:smoke                # computes all programs with defaults
bun run test:regression           # exact-value fixture cases

# 5. Dev server
bun run dev
```

## Bumping the release pin

When rulespec-us publishes a new `program-artifacts-<sha>` release:

1. Update `release_tag` + `corpus_sha` in `artifacts.lock.json` (and `engine.ref` if the engine moved).
2. `bun run artifacts:fetch` — downloads and sha256-verifies the new artifacts.
3. `bun run catalog:generate` — regenerates `src/lib/generated/catalog.json`; **review the coverage report and warnings** it prints (new programs, relation-inference fallbacks, period-coverage gaps).
4. `bun run test:smoke` — every program must compute green with pure defaults.
5. `bun run test:regression && bun run typecheck && bun run build`.
6. Commit the lock + catalog, deploy Modal (`modal deploy modal_app.py`), then Vercel.

New programs in the release show up in the chat and on `/programs` with no code changes. If a heuristic picks a wrong display name or primary output for a program, override it in `src/lib/catalog-overlay.ts`.

## What the demo will not do

- No fallback when the release does not certify a program: the model says Axiom has not encoded it instead of guessing.
- Outputs flagged `acknowledged_incomplete` by the rulespec authors are computed but explicitly flagged in the UI and in the model's answers.
- US only.

## Verification

```bash
bun run typecheck
bun run build
bun run test:legal-links
bun run test:smoke          # needs the engine (local binary or AXIOM_ENGINE_URL)
bun run test:regression     # needs the engine
bun run test:oracle         # engine vs frozen PolicyEngine values on identical households
bun run eval:llm            # end-to-end LLM answers vs engine/oracle ground truth (needs dev server + OPENAI_API_KEY)
```

`test:oracle` compares the request-builder path against PolicyEngine (policyengine-us) on identical households — SNAP in NY/CO/CA/AZ and federal income tax/CTC — with the PolicyEngine side frozen in `scripts/oracle-cases.json` (refresh via `python3 scripts/oracle-pe.py --update`). Population-scale Axiom↔PolicyEngine agreement is tracked separately in [axiom-oracles](https://github.com/TheAxiomFoundation/axiom-oracles).

## Deployment

Two services on PolicyEngine accounts:

- **Modal** hosts the `axiom-rules-engine` binary + all release artifacts (`modal_app.py`, pin read from `artifacts.lock.json`).
- **Vercel** hosts the Next.js app, calling Modal via `AXIOM_ENGINE_URL`.

Local dev works without either service because the engine adapter falls back to the local Rust binary when `AXIOM_ENGINE_URL` is unset.

Step-by-step in [DEPLOY.md](./DEPLOY.md).
