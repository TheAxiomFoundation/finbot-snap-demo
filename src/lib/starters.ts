/** Pre-written starter prompts: three state TANF maximum-benefit lookups,
 *  each short and phrased the way a real person asks. Chosen by
 *  eval/preset-compare.ts plus direct OpenAI API runs (2026-10-16) against
 *  the app's model, gpt-6-luna at its default settings, because the plain
 *  model gives the same stale amount every time while the engine matches
 *  PolicyEngine (5/5 runs each, through the app and straight on the API):
 *  - UT: plain model $498 vs $662 (oracle ut-tanf-family3).
 *  - CO: plain model $508 vs $620 for one caretaker + two children (oracle
 *    co-tanf-family3).
 *  - AL: plain model $215 vs $344/month, raised 2024-10-01 (oracle
 *    al-tanf-family3). Every OpenAI model tested, gpt-5.5 through
 *    gpt-6.1-sol, said $215 in all but one run. The grounded reply on
 *    gpt-6-luna leads with the certified annual figure ($4,128/year).
 *  Stale knowledge is the durable gap: more reasoning doesn't fix it, while
 *  arithmetic gaps close on stronger settings. Rejected on gpt-6-luna:
 *  CTC ($95,000, two kids) — the plain model already says $4,400; EITC
 *  (HoH, two kids, $40,000) — the grounded side stops on a failed
 *  qualifying-child check instead of repairing it (1/5); MD TANF — $727 vs
 *  $773 every time, but PolicyEngine 1.774.5 has $753 and can't
 *  independently confirm IM 26-13. With web search on, the plain model gets
 *  these lookups right; both compare-mode sides run without it.
 *  All three programs carry acknowledged_incomplete flags in the certified
 *  catalog, so replies may note that parts of the rule chain aren't fully
 *  encoded. SNAP (flag-free) waits for the FY2027 COLA in rulespec-us: its
 *  rules stop at FY2026 while "now" is FY2027. */
export const STARTERS: readonly string[] = [
  "What's the maximum TANF benefit for a family of 3 in Utah?",
  "What's the maximum TANF benefit for a single parent with two kids in Colorado?",
  "What's the maximum TANF benefit for a family of 3 in Alabama?",
];
