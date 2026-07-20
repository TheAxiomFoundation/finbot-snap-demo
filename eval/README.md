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
