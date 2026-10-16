/** Pre-written starter prompts: three question shapes (a lookup, a
 *  two-state comparison, a "one more child" difference), each short and
 *  phrased the way a real person asks. Chosen by eval/preset-compare.ts plus
 *  direct OpenAI API runs (2026-10-16) against the app's model, gpt-6-luna at
 *  its default settings; 5/5 grounded answers correct on each, values checked
 *  against state sources, not just the engine:
 *  - UT lookup: plain model $498 vs $662 (DWS Table 1, which the DWS
 *    customer page matches for sizes 1–8).
 *  - AL vs GA: plain model says Georgia ($280 vs $215) in 5/5 runs; Alabama
 *    pays more ($344 since the 2024-10-01 state plan vs $280).
 *  - CO third child: plain model gives $90–$152 or no figure; the 2025-07-01
 *    grant chart (frozen through June 2028 by SB26-181) gives $754 − $620 =
 *    $134.
 *  Stale knowledge is the durable gap: more reasoning doesn't fix it. What
 *  didn't make the cut on gpt-6-luna, and why:
 *  - tax (CTC, OASDI above the wage base, 2026 brackets): the plain model
 *    already answers correctly;
 *  - TANF with earnings / eligibility: AL encodes a 20% work-expense
 *    deduction where Ala. Admin. Code r. 660-2-2-.30(2) says 30% (plus a
 *    12-month new-job disregard); GA takes its earned-income deductions as
 *    caller inputs, so the grounded side can't finish either question;
 *  - EITC: the grounded side stops on a failed qualifying-child check;
 *  - UT "family of 4 vs 3": luna flipped the sign once in five;
 *  - SNAP: rules stop at FY2026 while "now" is FY2027.
 *  With web search on, the plain model gets these lookups right; both
 *  compare-mode sides run without it. The TANF programs carry
 *  acknowledged_incomplete flags, so replies may note that parts of the
 *  rule chain aren't fully encoded. */
export const STARTERS: readonly string[] = [
  "Single mom with two kids: does Alabama or Georgia pay more TANF?",
  "What's the maximum TANF benefit for a family of 3 in Utah?",
  "In Colorado, how much more TANF does a single parent get with three kids instead of two?",
];
