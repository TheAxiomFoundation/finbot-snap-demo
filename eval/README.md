# Prompt-review harness (internal — not surfaced in the app)

End-to-end review of what the assistant actually says on the PolicyEngine
oracle scenarios (`scripts/oracle-cases.json`), treated the way a human prompt
reviewer would: capture the full transcript, check the numbers against the
oracle, and grade the answer's craft — not just its headline.

## Run

```bash
# dev server must be running with OPENAI_API_KEY (bun run dev -- --port 3947)
bun run eval:oracle                       # default model
FINBOT_EVAL_URL=http://localhost:3947 bun run eval:oracle
```

Each run writes `eval/runs/<timestamp>-<model>/`:

- `<case>.md` — full transcript: prompt, every tool call with args and
  (truncated) result, timings per step, the final reply, and the rubric
  verdicts for that case.
- `summary.json` — machine-readable results for diffing runs.

`eval/runs/` is gitignored — transcripts are working artifacts; re-run to
regenerate. The harness and rubric are the durable, versioned parts.

## Rubric (automated per case)

| Check | Meaning |
|---|---|
| `value` | Headline matches the engine/PolicyEngine-agreed oracle value (tolerance per case) |
| `grounded` | Every dollar figure in the reply exists in a tool result (or is user-stated / a shown wage derivation) |
| `engine` | compute/lookup_value actually ran — no recall-only answers |
| `assumptions` | Reply has an Assumptions section disclosing inferences/defaults |
| `period` | The evaluation period is stated |
| `incomplete` | acknowledged_incomplete flags surfaced when any tool result carried them |
| `budget` | Wall time ≤ 35s and ≤ 6 model steps |

## Human review pass

The rubric catches regressions; it does not replace reading. After a run,
review each transcript for:

- wrong-but-plausible slot mappings (near-miss names the checks can't see),
- assumptions that are technically disclosed but misleading,
- over-hedging or editorializing,
- wasted tool calls (repeat describes/searches — these show up in timings).

Record findings in the run directory (`REVIEW.md`) so the next reviewer can
diff behavior across model/prompt changes.

## Model comparisons

`FINBOT_MODEL` is read by the dev server, so to compare tiers restart the
server with the override and re-run:

```bash
FINBOT_MODEL=gpt-5.5-mini bun run dev -- --port 3948 &
FINBOT_EVAL_URL=http://localhost:3948 bun run eval:oracle
```

Run directories are suffixed with the model name reported by the server.

## Known instabilities (2026-07-21 baseline)

Across nine full runs on gpt-5.5 (temperature 0.2), per-run pass rate ranged
26–29 of 32. Failures rotate through a small set of repair-flow cases rather
than repeating deterministically:

- **Gate-repair skips** — ks-tanf-family3, il-scretd-nl, eitc-childless-nl
  occasionally report $0 when a run doesn't execute the requires-repair
  recompute (unset assistance-plan/procedural/age gates). The prompt names
  the pattern (sanity-check zeros, prospective prerequisites); residual
  variance is the model's.
- **fiit-wages-only-honesty** — behavior varies between the ideal ($4,400 CTC
  + ask for taxable income) and honest-but-lesser variants (ask-only;
  once: a remembered standard deduction, now banned and rubric-caught).
  Blocked on rulespec-us#953 for the real computation.
- **describe-thrash** — explanation/repair turns sometimes probe
  describe_program repeatedly and blow the step budget without being wrong.
- **Transport timeouts** — back-to-back full runs hit OpenAI rate limits
  (180s aborts with 0–2 steps). Space runs ≥5 minutes apart.

Treat a case as regressed when it fails on a NEW check or twice
consecutively on the same one — not on a single rotating flake.
