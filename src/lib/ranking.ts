/**
 * Next-best-question ranking via variance reduction.
 *
 * For each candidate unknown, run the engine with the bracket extremes
 * (e.g. `pays_separate_heating_or_cooling: true` vs `false`) and measure how
 * much the primary output (regular monthly SNAP allotment) moves. Rank by
 * absolute movement; the top question is the one that collapses uncertainty
 * the most given everything else we already know.
 */
import { compute, type CoSnapFacts } from "./programs/co-snap";

function numericOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

interface CandidateQuestion {
  fact_key: keyof CoSnapFacts;
  brackets: [unknown, unknown];
  bracket_labels: [string, string];
  question: string;
  why: string;
}

const CANDIDATES: CandidateQuestion[] = [
  {
    fact_key: "pays_separate_heating_or_cooling",
    brackets: [true, false],
    bracket_labels: ["yes — heating/cooling separate", "no — bundled in rent"],
    question: "Do you pay heating or cooling costs separately from your rent or mortgage?",
    why: "Eligibility for the standard utility allowance versus the limited utility allowance moves the excess shelter deduction by hundreds of dollars per month.",
  },
  {
    fact_key: "any_member_elderly_or_disabled",
    brackets: [true, false],
    bracket_labels: ["yes — elderly or disabled member", "no"],
    question: "Is anyone in the household 60 or older, or receiving disability benefits?",
    why: "An elderly or disabled member changes the asset limit, removes the gross income test, and unlocks the medical expense deduction.",
  },
  {
    fact_key: "monthly_shelter_costs",
    brackets: [0, 1500],
    bracket_labels: ["no out-of-pocket shelter costs", "high shelter costs"],
    question: "About how much do you pay each month for rent or mortgage out of pocket?",
    why: "The excess shelter deduction is the largest single deduction for most working households and depends on confirmed shelter costs.",
  },
  {
    fact_key: "monthly_unearned_income",
    brackets: [0, 1500],
    bracket_labels: ["no unearned income", "significant unearned income"],
    question: "Do you receive any unemployment benefits, Social Security, child support, or other unearned income?",
    why: "Unearned income counts toward gross and net income with no earned-income deduction and can flip eligibility.",
  },
  {
    fact_key: "liquid_resources",
    brackets: [0, 5000],
    bracket_labels: ["under the SNAP asset limit", "over the SNAP asset limit"],
    question: "What's the rough total of cash and money in checking or savings accounts?",
    why: "If countable resources exceed the SNAP limit the household becomes resource-ineligible regardless of income.",
  },
];

export interface RankedQuestion {
  question: string;
  why: string;
  fact_key: string;
  variance_dollars: number;
  bracket: { values: [unknown, unknown]; labels: [string, string]; allotments: [number, number] };
}

/** Rank candidate next-questions by variance in regular monthly allotment. */
export async function rankNextQuestions(
  facts: CoSnapFacts,
  options: { only?: Array<keyof CoSnapFacts> } = {}
): Promise<RankedQuestion[]> {
  const candidates = options.only
    ? CANDIDATES.filter((c) => options.only!.includes(c.fact_key))
    : CANDIDATES;

  // Skip a candidate if the fact is already specified.
  const open = candidates.filter((c) => facts[c.fact_key] === undefined);

  const ranked: RankedQuestion[] = [];
  for (const c of open) {
    const [a, b] = c.brackets;
    const [aFacts, bFacts] = [
      { ...facts, [c.fact_key]: a },
      { ...facts, [c.fact_key]: b },
    ];
    const [aRes, bRes] = await Promise.all([
      compute(aFacts as CoSnapFacts).catch(() => null),
      compute(bFacts as CoSnapFacts).catch(() => null),
    ]);
    const aAllot = numericOr(aRes?.outputs.snap_regular_month_allotment, 0);
    const bAllot = numericOr(bRes?.outputs.snap_regular_month_allotment, 0);
    ranked.push({
      question: c.question,
      why: c.why,
      fact_key: String(c.fact_key),
      variance_dollars: Math.abs(aAllot - bAllot),
      bracket: {
        values: [a, b],
        labels: c.bracket_labels,
        allotments: [aAllot, bAllot],
      },
    });
  }
  ranked.sort((x, y) => y.variance_dollars - x.variance_dollars);
  return ranked;
}
