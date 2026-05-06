/** Pre-written starter prompts shared by the FinBot chat and the Side-by-side
 *  comparison. One source of truth so the two surfaces stay in sync.
 *
 *  Ordered by complexity, left → right. The left card is a pure parameter
 *  lookup (the engine only needs lookup_value); the middle is a single-
 *  person eligibility check; the right is a full household calculation
 *  exercising the earned-income deduction and the shelter deduction.
 *  All three are SNAP-only — no questions about adjacent benefits,
 *  since the demo only encodes the Colorado SNAP rulebook. */
export const STARTERS: readonly string[] = [
  "What's the maximum SNAP allotment for a household of 4 in Colorado?",
  "I'm single in Colorado earning $1,400/month before taxes. Would I qualify for SNAP?",
  "I'm in Colorado with two kids, work 30 hrs/week at $16/hr, and pay $1,300/month rent. What would my SNAP benefit be?",
];
