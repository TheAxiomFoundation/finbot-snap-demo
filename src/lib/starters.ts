/** Pre-written starter prompts. Three defaults spanning program types
 *  (a SNAP benefit calc, a federal income-tax question, a TANF lookup);
 *  ordered simple → complex. */
export const STARTERS: readonly string[] = [
  "What's the maximum TANF benefit for a family of 3 in Maryland?",
  "I'm in New York with two kids, work 30 hrs/week at $16/hr, and pay $1,300/month rent. What would my SNAP benefit be?",
  // Taxable income is stated because the pinned release takes it as an input
  // (26 USC 63 not yet encoded — rulespec-us#953). Once that lands, this can
  // go back to wages-only.
  "We're a married couple filing jointly with two young kids. Our taxable income is $62,800 on $95,000 of wages. What's our 2026 federal income tax and child tax credit?",
];
