# finbot-snap-demo

Live FinBot demo: OpenAI side-by-side comparison grounded in Colorado SNAP rules via the [Axiom rules engine](https://github.com/TheAxiomFoundation/axiom-rules). No PolicyEngine, no model-recall numbers — every dollar amount comes from a real `axiom-rules` compute.

## What it is

- Next.js + AI SDK chat surface.
- Tools the model can call: `list_encoded_outputs`, `compute_co_snap`, `rank_next_question`, `fetch_citation`.
- Tools shell out to the `axiom-rules` Rust binary running against a compiled artifact built from `rules-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml`.
- A side-by-side comparison page that runs the same question through (a) GPT-4o alone and (b) GPT-4o with the axiom tools wired in.

## Stack

| Layer | What |
|---|---|
| Chat UI | Next.js 15 App Router + AI SDK v5 (`ai` + `@ai-sdk/openai` + `@ai-sdk/react`) |
| Engine | `axiom-rules` Rust binary, spawned per request via `child_process.spawn` |
| Rules content | `rules-us-co` (CO SNAP composition) + `rules-us` (federal imports) |
| Citations | `axiom-foundation.org/api/axiom/documents/...` |

There is no Python in the runtime path.

## Setup

You need Rust + Node (or Bun).

```bash
# 1. Clone axiom-rules + rules-us + rules-us-co, build the binary, compile artifacts
bun run engine:setup        # or: npm run engine:setup

# 2. Install web deps
bun install                 # or: npm install / pnpm install

# 3. Add your OpenAI key
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY

# 4. Smoke-test the engine end-to-end (no OpenAI needed for this)
bun run engine:test

# 5. Dev server
bun run dev
```

The setup script clones the three Axiom repositories under `engine/` and runs `cargo build --release`. The engine binary lives at `engine/axiom-rules/target/release/axiom-rules`. Compiled artifacts land in `engine/artifacts/co-snap.compiled.json`.

## Adding a new program

1. Add a new `compile` line to `scripts/build-artifacts.sh` pointing at a new RuleSpec YAML.
2. Add a program-specific TS module like `src/lib/programs/<slug>.ts` mirroring `co-snap.ts` — typed user-facing facts → legal-ID inputs → engine call.
3. Append to `src/lib/catalog.ts`.
4. Add a tool to `src/lib/tools.ts` (e.g. `compute_us_eitc`).

The system prompt in `src/lib/prompts.ts` is intentionally generic about the catalog — once a new program is registered it shows up automatically through `list_encoded_outputs`, so the LLM stops claiming the program "isn't encoded yet" the moment it is.

## What the demo *won't* do

- No fallback when `axiom-rules` doesn't have a rule yet. The model says "axiom hasn't encoded that" instead of guessing.
- No Medicaid, no federal EITC, no other state's SNAP — those would be straightforward additions following the layout above; just no canonical RuleSpec content yet.
- No initial-month proration in the chat; the underlying rules support it but the friendly contract intentionally omits it for v1.

## Verification

`bun run engine:test` reproduces the verified base case: single applicant aged 60 in Colorado, $1,000/mo wages, $500 shelter cost, separate heating → **$298 monthly allotment, eligible**, matching `rules-us-co` test fixture exactly.
