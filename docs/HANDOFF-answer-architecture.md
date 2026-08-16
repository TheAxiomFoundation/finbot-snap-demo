# Handoff: answer-architecture work (finbot-snap-demo)

**Branch:** `claude/quirky-cray-nrr3z1` (pushed; head `1817c66` at time of writing)
**Date:** 2026-08-16
**Status:** Design + trace investigation done and committed. Phase 0 implementation not started — that is the next task.

## The task in one paragraph

The question being answered: how should an LLM app call the Axiom rules engine
when precision, transparency, and speed are the whole product? The answer, argued
in `docs/answer-architecture.md` (committed, with a rendered artifact linked in
its header): it is an API design problem — build a **Scenario & Query layer**
between engine and model (deterministic bindings in, exact trace provenance
through, claim verifier out); the tool list is a projection of that layer. The
trace investigation (appendix §10 of that doc) then proved the cheapest phase is
even cheaper than designed: the engine already runs in explain mode on every
production compute and the app discards the trace it is already paying for.

## Durable resources (all committed — nothing lives only in a container)

- `docs/answer-architecture.md` — the design note. Five positions, six-tool
  surface, provenance envelope (§7.2), phased roadmap (§7.3), PE-compat analysis
  implications, open questions (§9), trace findings (§10).
- Rendered artifact (same content):
  https://claude.ai/code/artifact/582b2ee6-50ce-456a-8fce-b1ecc46ea921
- `scripts/trace-dump.ts` — rerunnable: `bun x tsx scripts/trace-dump.ts us-ny-snap`
  (needs the local engine; see "Environment setup" below).
- Companion doc (different scope, don't confuse): artifact "Axiom API — Flagship
  Design" — the *hosted* API design, incl. the PolicyEngine household-API compat
  facade. This repo's work is the agent-facing instance of the same bet.

## Verified findings (all re-checkable, references in the doc)

1. `ExecutionResponse.results[].trace` is declared at `src/lib/engine.ts:81` and
   read **nowhere** — the only occurrence of `trace` in `src/`.
2. `buildRequest` already defaults `mode: "explain"` (`src/lib/request-builder.ts:462`)
   → the trace is computed and shipped on every compute today. Phase 0 has zero
   engine cost.
3. Trace = fired-rule closure only (engine `collect_trace`, `src/api.rs`): 44–114
   nodes / 20–49 KB measured on us-ny-snap, us-co-snap, us-fiit; 12–33 ms wall.
   Every node has legal id + source citation + source_url + dependencies (+
   rounding provenance). A ~20-line dependency walk renders the full cited legal
   derivation with no model involvement.
4. Catalog scale: 34 programs / 14,014 input slots / 7,515 outputs, release
   `program-artifacts-09d8d50a9add`. Runtime vocabulary mapping over this is
   where the eval failures live (26–29/32, rotating — `eval/README.md`).
5. Latency is model round-trips, not engine (<50 ms engine vs 8–30 s wall).

## Decisions already made (don't re-litigate; user has confirmed direction)

- Priorities: **Phase 0 first** (surface trace + provenance + stamps + runtime
  claim verifier — it is measurement infrastructure), then re-baseline the eval
  (nine runs, like the 2026-07-21 baseline), then Phase 1 (Canonical Fact Model).
- PE household-API support: the compat **plumbing** is orthogonal (lives in the
  hosted API as an edge facade), but the **vocabulary is shared** — seed the
  Canonical Fact Model from PE's household schema, scope bindings by PE demand,
  design the binding table as a shared asset upstream `(canonical_fact, program,
  entity) → slot + transform`. Phase 0 is unaffected by any of this.

## Next task: Phase 0 implementation

1. In `shapeResult` (`src/lib/request-builder.ts`): keep the trace, derive
   per-output `rule_path` (BFS over `dependencies`) and `parameters_used` (leaf
   nodes), attach `stamps` (`release_tag`/`corpus_sha` from
   `src/lib/generated/catalog.json`, `engine_ref` from `artifacts.lock.json`).
2. Keep the trace **out of the model's tool results** (20–50 KB would blow up
   context); ride it to the UI as AI SDK stream annotations from
   `src/app/api/chat/route.ts`.
3. Port the eval's `grounded` predicate (`eval/oracle-eval.ts`) into the route as
   a runtime verifier — first cut: check at `onFinish`, log/annotate, don't block.
4. Validate: `bun run test:oracle` (engine-level oracle, no LLM needed), then
   `bun run eval:oracle` against a dev server if an OPENAI_API_KEY is available.
   Expect no behavior change — Phase 0 must not alter what the model sees except
   additively.

Watch out for: `lookup_value` and `computeProgram` share `shapeResult` — both get
provenance for free, but check payload size on what each tool returns to the
model. Dependencies may reference keys absent from the trace (short-circuited
branches) — handle missing keys; it's signal ("branch never reached"), not error.

## Environment setup (fresh container)

```bash
bun install
bash scripts/setup-engine.sh   # needs Rust; clones engine at locked ref, builds, fetches artifacts
# or piecewise: clone TheAxiomFoundation/axiom-rules-engine into engine/axiom-rules-engine,
#   checkout ref from artifacts.lock.json, cargo build --release,
#   then: bun x tsx scripts/fetch-artifacts.ts
bun x tsx scripts/trace-dump.ts us-ny-snap   # sanity check
```

`engine/` and `eval/runs/` are gitignored — they die with the container; only
committed files and the artifact survive. Commit anything worth keeping.
