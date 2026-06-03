import type { Country } from "./catalog";

/** Pre-written starter prompts shared by the FinBot chat and the Side-by-side
 *  comparison. One source of truth so the two surfaces stay in sync.
 *
 *  US ordered by complexity, left → right (lookup, eligibility, full calc).
 *  UK is currently a single program (personal allowance); the three starters
 *  probe different mechanics: base allowance, the £100k taper, and full taper. */
export const STARTERS_US: readonly string[] = [
  "What's the maximum SNAP allotment for a household of 4 in Colorado?",
  "I'm single in California earning $1,400/month before taxes. Would I qualify for SNAP?",
  "I'm in New York with two kids, work 30 hrs/week at $16/hr, and pay $1,300/month rent. What would my SNAP benefit be?",
];

export const STARTERS_UK: readonly string[] = [
  "What's the UK personal allowance for someone earning £50,000?",
  "I earn £120,000 — what's my personal allowance?",
  "At what income does the personal allowance fully taper to £0?",
];

/** Back-compat — old callers get the US starters. */
export const STARTERS = STARTERS_US;

export function startersForCountry(country: Country): readonly string[] {
  return country === "uk" ? STARTERS_UK : STARTERS_US;
}
