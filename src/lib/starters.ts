/** Pre-written starter prompts. Three defaults spanning program types
 *  (a TANF lookup, an EITC calc, a CTC calc), each phrased the way a real
 *  person asks and chosen because the plain-model answer visibly diverges
 *  from the engine's: stale $727 vs $773 (MD), a hedged range vs $3,923
 *  exact (EITC), and TCJA-sunset guesses ($1,000–2,000/child) vs the
 *  current-law $4,400 (CTC). The CTC question asks about the credit rather
 *  than total income tax because tax needs taxable income, which the pinned
 *  release takes as an input (26 USC 63 not yet encoded — rulespec-us#953);
 *  widen back to "income tax and child tax credit" once that lands. */
export const STARTERS: readonly string[] = [
  "What's the maximum TANF benefit for a family of 3 in Maryland?",
  "I'm head of household with two qualifying kids and earned $40,000 in 2026. What's my exact federal EITC?",
  "We're a married couple filing jointly making $95,000 with two kids, ages 8 and 5. How much child tax credit do we get in 2026?",
];
