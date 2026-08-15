# How an LLM app should call the Axiom rules engine

**Status:** Draft for review · Reconstructed 2026-08-15 · Branch `claude/quirky-cray-nrr3z1`
**Rendered version:** https://claude.ai/code/artifact/582b2ee6-50ce-456a-8fce-b1ecc46ea921

> **Reconstruction note.** The original of this note was written to
> `docs/HANDOFF-answer-architecture.md` but never committed, and the container it
> lived in was reclaimed. Its companion artifact no longer resolves. This document
> rebuilds the argument from the surviving summary and re-grounds every factual
> claim against the code in this repo at `d08f2cb`. Claims carry file:line
> references so the next reader can check them rather than trust them.

---

## 1. The question

If **precision, transparency, and speed** are the whole product — not features of
it — how should an LLM application call a rules engine? Specifically:

- What should the engine expose to the model?
- What sits between them?
- Is this an API design problem, or a prompting problem?

The short answer to the last one: it is an API design problem, and treating it as
a prompting problem is what produces the failure modes we measure today.

## 2. Where this app stands

Three findings, each verifiable in the tree.

### 2.1 The engine already returns a derivation trace. The app throws it away.

`ExecutionRequest` carries `mode: "fast" | "explain"` (`src/lib/engine.ts:64`) and
`ExecutionResponse.results[].trace` is declared at `src/lib/engine.ts:81`.

`trace` appears **exactly once in the entire `src/` tree** — that declaration.
Nothing reads it. The engine computes a full derivation, ships it over the wire,
and the app drops it on the floor.

Everything the product calls "transparency" is currently reconstructed *after the
fact*, by the model, from flattened output values — the `extra_outputs` mechanism
(`src/lib/tools.ts:184-188`), the `applied` report (`src/lib/request-builder.ts:181`),
and prose instructions telling the model to show arithmetic on tool-returned
numbers (`src/lib/prompts.ts:46`). The real derivation was available the whole time.

**This is the single highest-leverage fact in the repo.**

### 2.2 The model does vocabulary mapping at runtime, and that is where the failures are.

The pinned catalog (`program-artifacts-09d8d50a9add`) contains:

| Quantity | Count |
|---|---:|
| Programs | 34 |
| Input slots | 14,014 |
| Encoded outputs (derived) | 7,515 |
| Parameters | 2,701 |
| Relations | 45 |

Slots are keyed by entity (`program.inputs` is `Record<entity, slot[]>`,
`src/lib/describe.ts:45`), and names come from the legal text of each program
independently. There is no shared vocabulary across the 34 programs: "income" is
`snap_total_monthly_unearned_income` in one and `taxable_income` in another, and
the model is asked to bridge from *"I make $16/hr"* to the right one of 14,014
names, live, mid-conversation.

The compensations are visible everywhere:

- `describe.ts` caps displayed slots at 120 (`INPUT_CAP`), hides auxiliary slots
  off the certified path, and compresses each slot into a hand-rolled mini-syntax
  (`name:dtype{1=joint,2=separate}(eq 12)*`) with a `slot_legend` to decode it
  (`src/lib/describe.ts:82`).
- `request-builder.ts:245` emits a `WARNING` when a fact lands on an auxiliary
  slot that doesn't feed the certified outputs — i.e. the model picked a
  plausible-but-wrong name and the headline silently ignored it.
- `tools.ts` returns `UnknownInputError`/`UnknownOutputError` with nearest-match
  suggestions so the model can self-correct on the next round-trip
  (`src/lib/tools.ts:74-90`).

The eval harness confirms where this lands: **26–29 of 32 cases pass across nine
full runs**, with failures *rotating* rather than repeating — gate-repair skips,
`describe`-thrash, and "wrong-but-plausible slot mappings (near-miss names the
checks can't see)" (`eval/README.md:38-84`).

Rotating, non-deterministic failures are the signature of runtime vocabulary
mapping. You cannot prompt your way out of it; you can only move it offline.

### 2.3 Speed is not an engine problem.

The engine runs in well under 50 ms. Wall-clock is 8–30 s, and the eval budget
check allows **≤ 35 s and ≤ 6 model steps** (`eval/README.md:36`). The route
permits `maxSteps: 12` and `maxDuration: 300` (`src/app/api/chat/route.ts:11,56`).

Latency is model round-trips, nothing else. The instrumentation already says so:
the `timed` wrapper logs per-tool ms and bytes explicitly so latency can be
attributed between engine work (fast) and LLM round-trips (slow)
(`src/lib/tools.ts:92-110`), and `onStepFinish` logs per-step deltas
(`route.ts:106-113`).

Meanwhile the system prompt is roughly **2,500 tokens**, and reading it
(`src/lib/prompts.ts:40-59`) it is almost entirely workarounds: twenty hard rules
encoding failure modes — sanity-check zeros, don't trust near-miss slot names,
don't restrict relations, don't fish with repeated describes, never retract a
computed answer based on a differently-shaped recompute. Each rule is a scar from
a real eval failure. Every one of them is a structural defect being patched in
natural language.

Server-side prefetch already exists and is appended *after* the static prompt to
keep the cacheable prefix byte-identical (`route.ts:23-38, 50`) — the right
instinct, applied to one symptom.

---

## 3. Position 1 — It is an API design choice, but not the one it looks like

The instinct is "design better tools." That is downstream. The real object is a
**Scenario & Query layer** sitting between the engine and the model:

```
  user turn
      │
      ▼
┌─────────────────────────────────────────────────┐
│  Scenario & Query layer                         │
│                                                 │
│   bind      NL facts ──▶ canonical facts        │
│   plan      canonical facts ──▶ engine request  │
│   execute   engine (<50ms, mode=explain)        │
│   attribute trace ──▶ value ids + provenance    │
│   verify    draft prose ──▶ claims vs value ids │
└─────────────────────────────────────────────────┘
      │
      ▼
  model (renders, does not derive)
```

The tool list is a **projection** of this layer, not the layer itself. That
distinction matters because it decides where the hard work lives: in tested,
offline, deterministic code — or in the prompt.

**Build it as if it were public**, even while its only consumer is this app. The
discipline is what makes it correct: versioned, schema-first, deterministic,
provenance-carrying. An internal layer with no external contract drifts into
exactly the prompt-patching we have now. (The hosted API design note — *"The
flagship API: one layer over encoded law"* — makes the same architectural bet at
the product tier: TypeScript control plane, Rust data plane, provenance in every
response. This is the agent-facing instance of that bet.)

## 4. Position 2 — Precision by pipeline, not by instruction

Precision is not a property you request from a model. It is a property you
*enforce at three chokepoints*.

**In — deterministic bindings + dry-run.**
Fact resolution stops being a model responsibility. The layer maps user-supplied
facts to canonical slots through a tested binding table, then *dry-runs* the
request: which slots bound, which defaulted, which are unbound and material.
The model receives a resolved scenario, not 14,014 names and a legend.

**Through — exact trace provenance.**
Stop reconstructing derivations from flattened values. Run `mode: "explain"`,
carry the trace, and attribute every returned number to the rule path and
parameters that produced it. Citations become a property of the computation
rather than a separate `fetch_citation` round-trip the model has to remember to
make.

**Out — a claim verifier.**
Every number in the draft reply is checked against the value ids in the envelope
before the reply ships. The eval harness already implements exactly this check
offline — `grounded`: "every dollar figure in the reply exists in a tool result"
(`eval/README.md:31`). Promote it from a test to a runtime gate. A rubric that
catches an ungrounded number *after* the run is a regression test; the same
predicate applied *before* the response streams is a correctness guarantee.

This is the whole thesis: **the three properties the product sells are the three
stages of one pipeline.**

## 5. Position 3 — The Canonical Fact Model is the biggest investment

The layer needs a **Canonical Fact Model**: a small, stable, human-meaningful
vocabulary — household composition, earned/unearned income by period, shelter
costs, disability and elderly status, filing status, dependents — plus
**per-program bindings** that map each canonical fact onto that program's actual
slots, with unit and period conversions.

Properties that make it work:

- **Offline.** Authored and reviewed as data, not inferred per request.
- **Tested.** Each binding is a fixture: canonical fact in, expected slot and
  value out. Binding regressions become failing tests, not rotating eval flakes.
- **Auditable.** A binding table is reviewable by someone who knows the program;
  a prompt paragraph is not.
- **Partial by design.** A canonical fact with no binding for a program is an
  explicit gap, surfaced as such — not a silent default-to-zero.

This is deliberately the expensive item. It is also the one that converts the
failure class in §2.2 from "model variance" into "coverage we either have or
don't." Note that the entity keying of `inputs` means bindings are
`(canonical_fact, program, entity) → slot`, not a flat map — the member/primary
distinction is load-bearing (`describe.ts:87-89`).

## 6. Position 4 — Speed is fewer model steps

Three consequences, in order of payoff:

1. **Render from the envelope before prose.** The tool cards already show
   numbers, breakdowns, and citations — the prompt explicitly tells the model not
   to restate them (`prompts.ts:73`). Push that further: the structured answer is
   *displayable the moment the envelope returns*. The model's prose becomes
   commentary streamed alongside a result the user is already reading, not a
   serialized step gating it.

2. **Collapse round-trips into the layer.** `describe → compute → recompute` is
   three model steps for what is one planning decision. Prefetch already proves
   the pattern (`route.ts:34`); binding and dry-run generalize it. The
   requires-repair recompute the prompt spends four sentences describing
   (`prompts.ts:43`) is a *loop the layer should run*, not a behavior to coax.

3. **Sensitivity decides ask-vs-assume.** Today the model guesses whether a
   missing fact matters, guided by prose heuristics about zeros and gates
   (`prompts.ts:53`). The layer can answer it *quantitatively*: perturb the
   unbound fact, re-run (the engine is <50 ms — this is nearly free), and measure
   the swing. Large swing → ask, and make it the headline. Small swing → assume,
   disclose, move on. That converts the single most-litigated prompt rule into
   arithmetic.

## 7. Position 5 — The concrete shape

### 7.1 Six tools

Today there are five (`list_programs`, `describe_program`, `compute`,
`lookup_value`, `fetch_citation` — `src/lib/tools.ts:112-311`). The proposal
restructures rather than extends: `lookup_value` is already `compute` with a
single query (`tools.ts:250-259`), and `fetch_citation` becomes a property of the
trace rather than a separate call.

| Tool | Role |
|---|---|
| `find_program` | Coverage and output-name search. Mostly unnecessary — the prompt digest already answers it. |
| `describe_program` | The computable surface. Shrinks substantially once bindings exist: the model reads canonical facts, not raw slots. |
| `bind_scenario` | **New.** NL facts → canonical facts → resolved request. Returns bound / defaulted / unbound-and-material, plus a dry-run. The precision chokepoint on the way in. |
| `compute` | Executes with `mode: "explain"`. Returns the envelope (§7.2). |
| `explain_value` | **New.** Walks the trace for one value id: rule path, parameters with their legal ids and values, and the governing legal text. Subsumes `fetch_citation` and the `extra_outputs` fishing expedition. |
| `verify_answer` | **New.** Draft prose in, per-claim verdicts out against the envelope's value ids. The precision chokepoint on the way out. |

### 7.2 The envelope

Every execution returns one shape:

```jsonc
{
  "values": {
    "<value_id>": {
      "name": "snap_benefit", "legal_id": "us:statutes/7/2017/a#...",
      "entity": "Family", "period": {"kind": "month", "start": "...", "end": "..."},
      "unit": "usd", "semantics": "scalar", "value": 291,
      "certified": true, "acknowledged_incomplete": false
    }
  },
  "provenance": {
    "<value_id>": {
      "rule_path": ["<rule legal_id>", "..."],
      "inputs_used":     [{"slot": "...", "value": 0, "source": "user|default|overlay"}],
      "parameters_used": [{"legal_id": "...", "value": 204, "label": "..."}]
    }
  },
  "bindings": {
    "bound": [...], "defaulted": [...],
    "unbound_material": [{"canonical_fact": "...", "sensitivity": 0.0}],
    "warnings": [...]
  },
  "stamps": {
    "release_tag": "program-artifacts-09d8d50a9add",
    "corpus_sha": "...", "engine_ref": "...", "artifact_sha256": "...",
    "request_digest": "...", "evaluated_at": "..."
  }
}
```

Three things earn their place:

- **Value ids** give the verifier something to check *against*. Without stable
  ids, "is this number grounded?" is string matching on dollar amounts — which is
  what the eval rubric does today, and it is why near-miss slot mappings are
  described as failures "the checks can't see" (`eval/README.md:44`).
- **Provenance** is the transparency product, taken from the trace instead of
  reconstructed.
- **Stamps** make an answer reproducible months later — the property a partner
  defends to a state agency. `release_tag` and `corpus_sha` already exist in the
  catalog and `engine_ref` in the Modal lock (`modal_app.py:28-29`); they simply
  don't reach the response.

### 7.3 Roadmap

**Phase 0 — Surface what already exists.** Set `mode: "explain"`, stop discarding
`trace`, thread exact provenance and stamps into the response, and promote the
eval's `grounded` predicate into a runtime claim verifier. No new vocabulary, no
new model behavior. This phase is almost entirely deletion of workarounds, and it
delivers the transparency claim honestly for the first time.

**Phase 1 — Canonical Fact Model + bindings.** Offline, tested, per-program.
The expensive one (§5). Retires the largest block of prompt rules.

**Phase 2 — Envelope + render-before-prose.** Structured answer displays on
envelope return; prose streams alongside. The speed phase.

**Phase 3 — Sensitivity-driven ask-vs-assume.** Perturbation replaces heuristics.
Retires the zero-sanity-check and gate-repair rules.

**Phase 4 — Exposure.** MCP adapter and HTTP surface over the same layer.

Phase 0 is independently valuable and unblocks measurement of everything after
it — do it first, and re-baseline the eval before starting Phase 1.

---

## 8. How outsiders call it

One API, three exposures:

- **MCP** is the common way, and worth supporting first for third parties. It is
  plumbing over ordinary tool calling — a transport and discovery convention, not
  a different execution model. Nothing in the layer changes to support it.
- **Ordinary tool calling** is what this app does today and will keep doing. The
  MCP adapter and the in-process tool definitions project the same six tools.
- **Direct HTTP** for integrators who wire it themselves.

The layer is the product; the three exposures are packaging. Designing the layer
as if public (§3) is what keeps that true.

## 9. Open questions

1. **Canonical Fact Model scope.** Start narrow (SNAP + TANF, the largest
   certified cluster) or cover all 34 programs shallowly? Narrow-and-deep tests
   the thesis faster; broad-and-shallow finds the vocabulary's real shape sooner.
2. **Where the verifier's failure goes.** Does a failed claim block the response,
   trigger a repair round-trip (costing the latency we are trying to reclaim), or
   annotate visibly? Blocking is most correct and least shippable.
3. **Trace size.** `mode: "explain"` on a 7,515-output program could be large.
   Does the layer summarize the trace before the envelope, and if so, is the
   summarization itself a precision risk?
4. **Binding ownership.** Bindings encode legal judgment about which slot means
   which real-world fact. That is rulespec-author work, not app work — should
   bindings live in this repo at all, or upstream alongside the encodings?
