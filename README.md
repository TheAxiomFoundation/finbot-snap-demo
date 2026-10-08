# Chatbot demo

Live demo at [axiom.org/chatbot](https://axiom.org/chatbot): an OpenAI model (GPT-5.5 by default) that answers benefit and tax questions by calling the [Axiom rules engine](https://github.com/TheAxiomFoundation/axiom-rules-engine), with an optional side-by-side against the same model without tools. The app is fully **catalog-driven**: it can answer questions and run calculations for every program in the pinned [rulespec-us](https://github.com/TheAxiomFoundation/rulespec-us) `program-artifacts` release (SNAP, TANF, federal and state income tax, payroll tax, and more; `/programs` lists them).

The grounded side's system prompt requires every dollar amount to come from an `axiom-rules-engine` compute against sha256-verified compiled artifacts, never from model recall. That is an instruction, not a runtime guarantee; `bun run eval:llm` checks that the figures in a reply appear in that turn's tool results.

## AI disclosure

Every session starts under a compact notice (`src/components/SessionNotice.tsx`) naming the AI model and describing answers as estimates from encoded rules that may be incomplete. Its “Details” disclosure explains agency decisions, catalog coverage and where messages go: OpenAI, calculation inputs to the engine on Modal, and server error logs. Google Analytics tracks page views, scrolling, time on the page and outbound links; PostHog tracks page use and records sessions. The conversation, composer and chat errors carry `ph-no-capture`, which masks those elements in session recordings and excludes them from autocapture. Console recording is explicitly disabled, and chat errors are not logged to the browser console. The model name follows `FINBOT_MODEL`, and coverage labels follow the generated catalog. Each tool card and each program page shows the program's incomplete-output flags; a program with no flags is not a claim that its encoding is complete.

Links can enable comparison with `?compare=1` without clearing the chat, and prefill plain text with `?q=<question>` (500-character cap). Automatic submission requires `&go=1`; without it the question stays in the composer. Startup saves these options, then removes `q` from the browser URL before analytics starts. The initial request URL can still appear in hosting logs. A one-line estimate reminder also sits under the message box.

Don't describe these rules as "certified" in this app unless they are in Axiom's certification ledger (api.axiom.org `/v1/ready`, which reported the ledger empty on 2026-09-28). The release manifest only lists each program's `outputs`. The catalog's `certified` / `certified_outputs` fields are legacy internal names for "listed in the manifest's outputs"; user- and model-facing text calls them published outputs.

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
- **`/programs`** is a static coverage browser generated from the catalog — published outputs, incomplete flags, input slots, and links to the spec at the pinned corpus sha.

## Stack

| Layer | What |
|---|---|
| Chat UI | Next.js 15 App Router + AI SDK (`ai` + `@ai-sdk/openai` + `@ai-sdk/react`) |
| Engine | `axiom-rules-engine` Rust binary, Modal-hosted in production or spawned locally |
| Rules content | Compiled artifacts from the pinned `rulespec-us` GitHub release (no repo cloning, no local compilation) |
| Citations | `axiom.org/api/axiom/documents/...` + app.axiom-foundation.org legal links |

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

- No fallback when the release does not include a program: the model says Axiom has not encoded it instead of guessing.
- Outputs flagged `acknowledged_incomplete` in the program specs are computed but flagged in the tool cards, and the model is instructed to say so in its answer.
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

Two services:

- **Modal** (PolicyEngine workspace) hosts the `axiom-rules-engine` binary + all release artifacts (`modal_app.py`, pin read from `artifacts.lock.json`).
- **Vercel** (`axiom-foundation` team) hosts the Next.js app, calling Modal via `AXIOM_ENGINE_URL`.

Local dev works without either service because the engine adapter falls back to the local Rust binary when `AXIOM_ENGINE_URL` is unset.

Step-by-step in [DEPLOY.md](./DEPLOY.md).
