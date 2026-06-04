# FinBot demo

Live FinBot demo: OpenAI side-by-side comparison grounded in the [Axiom rules engine](https://github.com/TheAxiomFoundation/axiom-rules-engine). The app currently covers:

- US SNAP benefit calculations for Colorado, California, and New York.
- UK personal allowance under Income Tax Act 2007 s.35, including the GBP100k taper.
- UK Universal Credit monthly awards composed from WRA 2012 s.8 and UC Regs 2013.

No PolicyEngine, no model-recall numbers on the grounded side: every dollar or pound amount comes from an `axiom-rules-engine` compute.

## What it is

- Next.js + AI SDK chat surface with a US/UK country toggle.
- A side-by-side comparison mode that runs the same question through OpenAI alone and OpenAI + Axiom.
- The raw OpenAI side gets only country context and no tools; the Axiom side gets the country-specific system prompt and tool set.
- Tools the model can call:
  - US: `list_encoded_outputs`, `compute_co_snap`, `compute_ca_snap`, `compute_ny_snap`, `rank_next_question`, `lookup_value`, `fetch_citation`.
  - UK: `list_encoded_outputs`, `compute_uk_personal_allowance`, `compute_uk_universal_credit`, `fetch_citation`.
- The engine adapter calls the Modal-hosted Axiom engine in production, or the local Rust binary when `AXIOM_ENGINE_URL` is unset.

## Stack

| Layer | What |
|---|---|
| Chat UI | Next.js 15 App Router + AI SDK (`ai` + `@ai-sdk/openai` + `@ai-sdk/react`) |
| Engine | `axiom-rules-engine` Rust binary, either Modal-hosted or spawned locally |
| US rules content | `rulespec-us`, `rulespec-us-co`, and app-owned CA/NY SNAP program adapters |
| UK rules content | `rulespec-uk` personal allowance + prebuilt `axiom-programs` Universal Credit composition |
| Citations | `axiom-foundation.org/api/axiom/documents/...` and app.axiom-foundation.org legal links |

There is no Python in the web runtime path.

## Setup

You need Rust + Node or Bun.

```bash
# 1. Clone Axiom repos, build the binary, compile/copy artifacts
bun run engine:setup        # or: npm run engine:setup

# 2. Install web deps
bun install                 # or: npm install / pnpm install

# 3. Add your OpenAI key
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY

# 4. Smoke-test the engine paths
bun run engine:test
bun run engine:test:uk

# 5. Dev server
bun run dev
```

The setup script clones Axiom repositories under `engine/`, builds `engine/axiom-rules-engine/target/release/axiom-rules-engine`, compiles local artifacts into `engine/artifacts/`, and copies the prebuilt UK UC artifact from `axiom-programs`.

## Adding a new program

1. Add a new `compile` line to `scripts/build-artifacts.sh`, or copy a prebuilt artifact if the program still needs an upstream compose step.
2. Add a program-specific TS module like `src/lib/programs/<slug>.ts` that maps user-facing facts to legal-ID inputs and engine calls.
3. Append the program to `src/lib/catalog.ts`.
4. Add the country-specific tool in `src/lib/tools.ts`.
5. Add starter copy and country-specific prompt instructions only if the new program changes what users should ask.

The system prompts are country-scoped. Once a program is registered in the catalog and exposed through the right country tool surface, `list_encoded_outputs` should stop the model from claiming the program is not encoded.

## What the demo will not do

- No fallback when `axiom-rules-engine` does not have a rule yet. The model should say Axiom has not encoded it instead of guessing.
- US is limited to SNAP for Colorado, California, and New York.
- UK is limited to personal allowance and Universal Credit monthly award calculations. It does not yet compute Child Benefit, Council Tax Reduction, or the benefit cap as applied to a household.
- No initial-month SNAP proration in the chat; the underlying Colorado rules support it, but the friendly contract intentionally omits it for now.

## Verification

```bash
bun run test:country-copy
bun run typecheck
bun run build
bun run engine:test
bun run engine:test:uk
```

`bun run engine:test` reproduces the verified Colorado SNAP base case. `bun run engine:test:uk` covers personal allowance taper cases and composed Universal Credit award cases.

## Deployment

Two services on PolicyEngine accounts:

- **Modal** hosts the `axiom-rules-engine` binary at `https://policyengine--axiom-engine-web.modal.run` (`modal_app.py`).
- **Vercel** hosts the Next.js app, calling Modal via `AXIOM_ENGINE_URL`.

Local dev keeps working without either service because the engine adapter falls back to the local Rust binary when `AXIOM_ENGINE_URL` is unset.

Step-by-step in [DEPLOY.md](./DEPLOY.md).
