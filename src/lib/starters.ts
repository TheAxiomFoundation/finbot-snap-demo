/** BBCE candidates. The California starter is the Aspen page's CA-1 chip:
 *  $3,400/month for three people is about 150% of the poverty line under both
 *  the 2025 and 2026 HHS guidelines, between 130% and California's 200% limit. The real-engine
 *  regressions pin the California household; consumer ChatGPT needs human
 *  pretesting before it is presented as a reliable plain-model failure.
 *  Colorado is deferred: its categorical input bypasses an encoded IPV bar,
 *  so it cannot safely become an automatic default. Kept for
 *  scripts/bbce-regression.ts; not featured in STARTERS (see below). */
export const BBCE_STARTERS: readonly string[] = [
  "I'm a single mom in Fresno, California with two kids (8 and 5). I make $3,400 a month before taxes, pay $1,500 rent, and pay about $120 a month for utilities, including heat. Can we get CalFresh, and how much would we get each month?",
];

/** Pre-written starter prompts: one TANF question, one federal tax
 *  question and one SNAP eligibility question, each short and phrased the
 *  way a real person asks. Chosen by eval/preset-compare.ts plus direct
 *  OpenAI API runs (2026-10-16 to 2026-10-19) against the app's model,
 *  gpt-6-luna at its default settings, on program-artifacts-16a667719019,
 *  with every value checked against an outside source, not just the engine:
 *  - AL vs GA: plain model says Georgia ($280 vs $215) in 5/5 runs; Alabama
 *    pays more ($344 since the 2024-10-01 state plan vs $280, unchanged since
 *    1996). Grounded 5/5.
 *  - EITC: plain model answers "about $3,650" from the 2025 schedule or
 *    gives a range; IRS Rev. Proc. 2025-32 (two children: $7,316 maximum,
 *    phase-out from $23,890 at 21.06%) gives $3,923, matching the engine and
 *    PolicyEngine. Grounded 5/5 once failed judgments carry `failed_because`
 *    (it exposes the qualifying-child age check); the ages and SSNs in the
 *    question are needed. Asked as a single dad so the TANF and EITC
 *    starters are not both single moms; the filing status (head of
 *    household) and the answer are the same.
 *  - SNAP refugee: plain model says refugees can get SNAP right away in 9/10
 *    runs. Since P.L. 119-21 §10108 (2025-07-04), refugee status alone no
 *    longer qualifies — only citizens, LPRs, Cuban/Haitian entrants and COFA
 *    citizens (USDA FNS OBBB alien-eligibility Q&A). Grounded: "not
 *    eligible" 5/5, citing the 7 CFR 273.4 check (3/5 clean, 2/5 add doubt
 *    from the model's own priors). "No green card yet" matters: the
 *    2026-09-17 D. Or. ruling makes LPRs who were refugees or asylees
 *    eligible without the five-year wait, which is a different case.
 *  Rejected, and why:
 *  - CTC (incl. the $420,000 phase-out), OASDI above the wage base, 2026
 *    brackets, senior deduction, capital-gains thresholds: the plain model
 *    already answers correctly;
 *  - EITC with one child or married with three: the plain model lands
 *    within a few dollars, or the grounded side stops on the checks;
 *  - SNAP work requirements (H.R. 1 ages 18–64, child under 14): the plain
 *    model knows the change;
 *  - IL senior tax deferral: eligibility needs the Senior Freeze fact;
 *  - tariffs: the $200 on $1,000 of Chinese soccer balls includes a
 *    "reciprocal baseline" IEEPA duty although the same rules end IEEPA
 *    duties on 2026-02-20 — not shown until verified;
 *  - SNAP amounts: rules stop at FY2026 while "now" is FY2027
 *    (rulespec-us#1394).
 *  Spare TANF starter: "What's the maximum TANF benefit for a family of 3 in
 *  Utah?" ($662 vs plain $498). With web search on, the plain model gets the
 *  TANF lookups right; both compare-mode sides run without it. */
export const STARTERS: readonly string[] = [
  "Single mom with two kids: does Alabama or Georgia pay more TANF?",
  "Single dad, kids 8 and 5 with SSNs, $40,000 in wages in 2026. What's my EITC?",
  "I have refugee status but no green card yet, and I live in Florida with no income. Can I get SNAP?",
];
