/** BBCE candidates. The California starter is the Aspen page's CA-1 chip:
 *  $3,400/month for three people is about 150% of the poverty line under both
 *  the 2025 and 2026 HHS guidelines, between 130% and California's 200% limit. The real-engine
 *  regressions pin the California household; consumer ChatGPT needs human
 *  pretesting before it is presented as a reliable plain-model failure.
 *  Colorado is deferred: its categorical input bypasses an encoded IPV bar,
 *  so it cannot safely become an automatic default. */
export const BBCE_STARTERS: readonly string[] = [
  "I'm a single mom in Fresno, California with two kids (8 and 5). I make $3,400 a month before taxes, pay $1,500 rent, and pay about $120 a month for utilities, including heat. Can we get CalFresh, and how much would we get each month?",
];

/** The credit question asks about CTC because the pinned federal program
 *  takes taxable income as an input (26 USC 63 is not yet encoded). */
export const STARTERS: readonly string[] = [
  "What's the maximum TANF benefit for a family of 3 in Maryland?",
  ...BBCE_STARTERS,
  "We're a married couple filing jointly making $95,000 with two kids, ages 8 and 5. How much child tax credit do we get in 2026?",
];
