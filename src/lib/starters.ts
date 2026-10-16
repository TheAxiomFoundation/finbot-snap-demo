/** Pre-written starter prompts: a two-state TANF comparison, a federal EITC
 *  calculation, and a TANF lookup — each short and phrased the way a real
 *  person asks. Chosen by eval/preset-compare.ts plus direct OpenAI API runs
 *  (2026-10-16) against the app's model, gpt-6-luna at its default settings,
 *  with every value checked against an outside source, not just the engine:
 *  - AL vs GA: plain model says Georgia ($280 vs $215) in 5/5 runs; Alabama
 *    pays more ($344 since the 2024-10-01 state plan vs $280, unchanged since
 *    1996). Grounded 5/5.
 *  - EITC: plain model answers "about $3,650" from the 2025 schedule or
 *    gives a range; IRS Rev. Proc. 2025-32 (two children: $7,316 maximum,
 *    phase-out from $23,890 at 21.06%) gives $3,923, matching the engine and
 *    PolicyEngine. Grounded 4/5: the ages and SSNs in the question let the
 *    qualifying-child checks pass; without them gpt-6-luna stops and asks.
 *  - UT lookup: plain model $498 vs $662 (DWS Table 1, which the DWS
 *    customer page matches for sizes 1–8). Grounded 5/5.
 *  What didn't make the cut on gpt-6-luna, and why:
 *  - CTC, OASDI above the wage base, 2026 brackets: the plain model already
 *    answers correctly;
 *  - TANF with earnings / eligibility: AL encodes a 20% work-expense
 *    deduction where Ala. Admin. Code r. 660-2-2-.30(2) says 30% plus a
 *    12-month new-job disregard (rulespec-us#950); GA takes its earned-income
 *    deductions as caller inputs, so the grounded side can't finish;
 *  - CO "third child" difference: correct 5/5 but the headline still slips
 *    into "the modeled amount" 2/5;
 *  - SNAP: rules stop at FY2026 while "now" is FY2027 (rulespec-us#1394).
 *  With web search on, the plain model gets the TANF lookups right; both
 *  compare-mode sides run without it. */
export const STARTERS: readonly string[] = [
  "Single mom with two kids: does Alabama or Georgia pay more TANF?",
  "Single mom, kids 8 and 5 with SSNs, $40,000 in wages in 2026. What's my EITC?",
  "What's the maximum TANF benefit for a family of 3 in Utah?",
];
