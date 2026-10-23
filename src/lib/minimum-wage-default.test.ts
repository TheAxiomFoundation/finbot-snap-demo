import { describe, expect, it } from "vitest";

import { getCatalog, getProgram } from "./catalog";
import { describeProgramPayload } from "./describe";
import { buildRequest, computeProgram, type Facts } from "./request-builder";
import { engineAvailable, numericOutput } from "../../scripts/snap-scenarios";

// The SNAP encodings take the Federal minimum wage as an input. 7 CFR
// 273.7(b)(1)(vii) exempts from the work rules a person "earning weekly wages
// at least equal to the Federal minimum wage multiplied by 30 hours", and
// 273.5(b)(5) exempts a self-employed student earning it times 20 hours. At
// the old 0 default, $0 a week met both: in us-al/fl/ga/ma/nc/sc/tn-snap an
// adult of 35 with 4 countable ABAWD months, or who quit a job without good
// cause, got $298 where the rules give $0, and in every SNAP program a
// student self-employed 20 hours a week was exempt with no earnings. The
// rate is $7.25 an hour (29 USC 206(a)(1)(C)).
const WAGE_SLOTS = ["federal_or_state_minimum_wage", "federal_minimum_wage"];
const SNAP = [
  "us-al-snap", "us-ca-snap", "us-co-snap", "us-fl-snap", "us-ga-snap",
  "us-ma-snap", "us-nc-snap", "us-ny-snap", "us-sc-snap", "us-tn-snap",
];
const CASES: Record<string, Facts> = {
  abawd: { snap_abawd_countable_months_in_three_year_period: 4 },
  quit: { member_voluntarily_quit_or_reduced_work_below_30_hours_without_good_cause: true },
};
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

describe("Federal minimum wage default", () => {
  it("is $7.25 in every program that takes it, and on the path only in SNAP", () => {
    const slots = getCatalog().programs.flatMap((p) =>
      Object.values(p.inputs)
        .flat()
        .filter((s) => WAGE_SLOTS.includes(s.name))
        .map((s) => ({ slug: p.slug, ...s }))
    );
    for (const s of slots) expect(s, `${s.slug}:${s.name}`).toMatchObject({ default: 7.25, default_source: "overlay" });
    const onPath = slots.filter((s) => !s.aux).map((s) => `${s.slug}:${s.name}`);
    expect(onPath.sort()).toEqual(SNAP.flatMap((slug) => WAGE_SLOTS.map((name) => `${slug}:${name}`)).sort());
  });

  it("shows $7.25 in describe and discloses it unless the caller sets it", () => {
    const al = getProgram("us-al-snap")!;
    const payload = describeProgramPayload(al);
    expect(payload.inputs.Person.slots).toContain("federal_or_state_minimum_wage:decimal=7.25");
    expect(payload.default_overrides?.federal_or_state_minimum_wage).toBe(7.25);
    const facts = { household_size: 1 };
    expect(buildRequest({ program: al, period: "2026-10", facts }).applied.overlay_defaults_in_effect).toMatchObject({
      federal_or_state_minimum_wage: 7.25,
      federal_minimum_wage: 7.25,
    });
    const set = buildRequest({ program: al, period: "2026-10", facts, members: [{ facts: { federal_or_state_minimum_wage: 8 } }] });
    expect(set.applied.overlay_defaults_in_effect?.federal_or_state_minimum_wage).toBeUndefined();
  });
});

describe.skipIf(!hasEngine)("Federal minimum wage on the real engine", () => {
  // One adult, $300 unearned income, $600 rent, no work.
  const compute = (slug: string, member: Facts) => {
    const program = getProgram(slug)!;
    const primary = new Set(program.inputs[program.primary_entity].map((s) => s.name));
    const unearned = ["snap_total_monthly_unearned_income", "other_gain_or_benefit_payments"].find((n) => primary.has(n))!;
    const shelter = ["household_shelter_costs_incurred", "monthly_allowable_shelter_costs"].find((n) => primary.has(n))!;
    return computeProgram({
      program,
      period: "2026-10",
      facts: { household_size: 1, [unearned]: 300, [shelter]: 600 },
      members: [{ facts: member }],
    });
  };

  for (const slug of SNAP) {
    it(`${slug}: applies the work rules to an adult with no wages`, async () => {
      for (const [label, caseFacts] of Object.entries(CASES)) {
        const adult = await compute(slug, { member_age: 35, ...caseFacts });
        expect(numericOutput(adult, "snap_benefit"), label).toBe(0);
        // 30 hours at $7.25 is $217.50 a week. (member_weekly_wages feeds
        // only the exemption test here; the income slots stay as they are.)
        for (const [wages, benefit] of [[217, 0], [217.5, 298]] as const) {
          expect(numericOutput(await compute(slug, { member_age: 35, member_weekly_wages: wages, ...caseFacts }), "snap_benefit"), `${label} $${wages}`).toBe(benefit);
        }
        // A wage of 0 reproduces the old default: $0 a week met the exemption.
        const zero = await compute(slug, { member_age: 35, federal_or_state_minimum_wage: 0, ...caseFacts });
        expect(numericOutput(zero, "snap_benefit"), label).toBe(298);
      }
      // No work-rule facts: unchanged.
      expect(numericOutput(await compute(slug, { member_age: 35 }), "snap_benefit")).toBe(298);
    });

    it(`${slug}: exempts a self-employed student only from $145 a week`, async () => {
      // 273.5(b)(5): 20 hours a week and the Federal minimum wage times 20.
      const student = (earnings: number, extra: Facts = {}) =>
        compute(slug, {
          member_age: 30,
          student_age: 30,
          enrolled_at_least_half_time: true,
          enrolled_in_college_or_university_degree_program: true,
          student_self_employment_hours_per_week: 20,
          student_self_employment_weekly_earnings: earnings,
          ...extra,
        });
      expect(numericOutput(await student(0), "snap_benefit")).toBe(0);
      expect(numericOutput(await student(144), "snap_benefit")).toBe(0);
      expect(numericOutput(await student(145), "snap_benefit")).toBe(298);
      expect(numericOutput(await student(0, { federal_minimum_wage: 0 }), "snap_benefit")).toBe(298);
    });
  }
});
