/** Pre-written starter prompts. Three defaults spanning program types
 *  (a TANF lookup, an EITC calc, a federal income-tax question), each chosen
 *  because the plain-model answer visibly diverges from the engine's:
 *  stale $727 vs $773 (MD), a hedged range vs $3,923.23 exact (EITC), and
 *  the stale $2,000/child CTC vs current-law $4,400 (FIIT). */
export const STARTERS: readonly string[] = [
  "What's the maximum TANF benefit for a family of 3 in Maryland?",
  "I'm head of household with two qualifying kids and earned $40,000 in 2026. What's my exact federal EITC?",
  // Taxable income is stated because the pinned release takes it as an input
  // (26 USC 63 not yet encoded — rulespec-us#953). Once that lands, this can
  // go back to wages-only.
  "We're a married couple filing jointly with two young kids. Our taxable income is $62,800 on $95,000 of wages. What's our 2026 federal income tax and child tax credit?",
];
