/** Pre-written starter prompts. Three defaults spanning program types
 *  (a TANF lookup, a SNAP calc, a CTC calc), each phrased the way a real
 *  person asks and chosen because the plain-model answer visibly diverges
 *  from the engine's: stale $727 vs $773 (MD TANF), a hedged guess vs an
 *  exact certified monthly SNAP amount (NY, oracle case ny-snap-family3),
 *  and TCJA-sunset guesses ($1,000–2,000/child) vs the current-law $4,400
 *  (CTC). The federal EITC starter was dropped: `eitc` is listed under
 *  us-fiit's acknowledged_incomplete outputs in the certified catalog, same
 *  as `ctc_after_advance_payments` — but SNAP across the certified states
 *  (including NY) carries no incomplete flags, so it replaces EITC here as
 *  a question the pinned release actually backs end to end. The CTC
 *  question asks about the credit rather than total income tax because tax
 *  needs taxable income, which the pinned release takes as an input (26 USC
 *  63 not yet encoded — rulespec-us#953); widen back to "income tax and
 *  child tax credit" once that lands, and reconsider re-adding EITC once
 *  rulespec-us marks it complete. */
export const STARTERS: readonly string[] = [
  "What's the maximum TANF benefit for a family of 3 in Maryland?",
  "I'm a single parent in New York with two kids (8 and 5). I earn $2,078 a month, my rent is $1,300, and I pay heating separately from rent. What SNAP would we get?",
  "We're a married couple filing jointly making $95,000 with two kids, ages 8 and 5. How much child tax credit do we get in 2026?",
];
