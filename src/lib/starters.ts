/** Pre-written starter prompts: two TANF lookups and a CTC calc, each short
 *  and phrased the way a real person asks. Chosen by eval/preset-compare.ts
 *  plus direct OpenAI API runs (2026-10-16: gpt-5.5, no system prompt, 5
 *  runs at each of low/medium/high reasoning) because the plain model
 *  reliably misses a value the engine and PolicyEngine agree on, and more
 *  reasoning doesn't close the gap — the misses are stale knowledge, not
 *  arithmetic:
 *  - AL TANF: plain model said $215 (the old schedule) in 15/15 direct
 *    runs and 13/13 app runs; engine and PolicyEngine give $344/month
 *    (oracle al-tanf-family3).
 *  - UT TANF: plain model said $498 in 15/15 direct runs (and $498 or $583
 *    in 10/10 app runs); engine and PolicyEngine give $662 (oracle
 *    ut-tanf-family3).
 *  - CTC: plain model applied pre-2018 law ($2,000) in 8/8 app runs and was
 *    right in only 4/15 direct runs vs the current-law $4,400.
 *  Rejected: EITC (HoH, two kids, $40,000) — wrong at low reasoning but
 *  within $3 of $3,923 in 10/10 medium/high runs, so the gap came from the
 *  app's reasoning setting; CTC at $420,000 — right 5/5 at medium; MD TANF
 *  — $727 (once $785) vs $773 in 15/15, but PolicyEngine 1.774.5 has $753
 *  and can't independently confirm IM 26-13; TX and CO TANF — always wrong
 *  but scattered (TX got within $10 at high reasoning). With web search on,
 *  the plain model gets these lookups right; both compare-mode sides run
 *  without it.
 *  All three headline outputs come from programs with acknowledged_incomplete
 *  flags in the certified catalog, so replies carry a "not fully encoded"
 *  note. The flag-free areas don't make good presets yet: SNAP rules stop at
 *  FY2026 (effective 2025-10-01) while "now" is FY2027; OASDI is already
 *  right without the engine; IL SCRETD returned a spurious $0 in 2/3
 *  grounded runs. Revisit SNAP once rulespec-us encodes the FY2027 COLA. */
export const STARTERS: readonly string[] = [
  "What's the maximum TANF benefit for a family of 3 in Alabama?",
  "Married, $95,000 income, two kids. What's our 2026 child tax credit?",
  "What's the maximum TANF benefit for a family of 3 in Utah?",
];
