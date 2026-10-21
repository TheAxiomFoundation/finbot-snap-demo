import { describe, expect, it } from "vitest";

import { getCatalog, getProgram } from "./catalog";
import type { DerivedTraceNode } from "./engine";
import { buildSystemPrompt } from "./prompts";
import { computeProgram, type Facts, type MemberSpec } from "./request-builder";
import { ageRange, rangeLabel, unstatedAgeNote, unstatedAges } from "./unstated-ages";
import { engineAvailable, numericOutput } from "../../scripts/snap-scenarios";

// An unstated age is 0 (PR #66), and 0 passes every "younger than N" test.
// In us-ca/co/ny-snap two such tests are work-rule exemptions: 7 CFR
// 273.7(b)(1)(i) exempts "a person younger than 16 years of age or a person
// 60 years of age or older"; 7 USC 2015(o)(3)(A), as P.L. 119-21 amended it,
// excepts a person "under 18, or over 65, years of age" from the ABAWD time
// limit. A single adult with $300 unearned income and $600 rent got $298
// with 4 countable ABAWD months, or after quitting a job without good cause,
// where an adult aged 18 to 59 gets $0.
const GENERAL = "snap_member_general_work_requirement_exempt";
const ABAWD = "snap_member_abawd_exception_applies";
const WORK_RULE_STATES = ["us-ca-snap", "us-co-snap", "us-ny-snap"];
const CASES: Record<string, Facts> = {
  abawd: { snap_abawd_countable_months_in_three_year_period: 4 },
  quit: { member_voluntarily_quit_or_reduced_work_below_30_hours_without_good_cause: true },
};
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

const held = (...names: string[]): Record<string, DerivedTraceNode> =>
  Object.fromEntries(names.map((name) => [name, { kind: "judgment", name, outcome: "holds", dependencies: [] }]));

describe("age tests in the catalog", () => {
  it("lists each rule's own tests of a member's age slot", () => {
    for (const slug of WORK_RULE_STATES) {
      const outputs = getProgram(slug)!.outputs;
      expect(outputs.find((o) => o.name === GENERAL)!.age_tests).toEqual([
        { slot: "member_age", op: "lt", value: 16 },
        { slot: "member_age", op: "gte", value: 60 },
      ]);
      expect(outputs.find((o) => o.name === ABAWD)!.age_tests).toEqual([
        { slot: "member_age", op: "lt", value: 18 },
        { slot: "member_age", op: "gte", value: 65 },
      ]);
    }
  });

  it("lists them for the SNAP programs and us-fiit only", () => {
    const programs = getCatalog().programs.filter((p) => p.outputs.some((o) => o.age_tests)).map((p) => p.slug);
    // us-az-snap's member_age is auxiliary; no other program tests a member's age.
    expect(programs).toEqual([
      "us-al-snap", "us-ca-snap", "us-co-snap", "us-fiit", "us-fl-snap", "us-ga-snap",
      "us-ma-snap", "us-nc-snap", "us-ny-snap", "us-sc-snap", "us-tn-snap",
    ]);
    const fiit = getProgram("us-fiit")!.outputs.filter((o) => o.age_tests).map((o) => o.name);
    expect(fiit.sort()).toEqual(["age_requirements_met", "ctc_qualifying_child", "eitc_childless_age_eligible", "senior_deduction_qualified_individual"]);
  });
});

describe("unstated ages, from a trace", () => {
  const ca = getProgram("us-ca-snap")!;
  const unstated = () => false;
  const zero = () => 0;

  it("probes at the youngest age that passes none of the held tests", () => {
    const [entry] = unstatedAges(ca, held(GENERAL, ABAWD), unstated, zero);
    expect(entry.slot).toBe("member_age");
    expect(entry.passed.map((p) => [p.rule, p.tests])).toEqual([
      [GENERAL, [{ slot: "member_age", op: "lt", value: 16 }]],
      [ABAWD, [{ slot: "member_age", op: "lt", value: 18 }]],
    ]);
    expect(entry.probe).toBe(18);
    expect(unstatedAges(ca, held(GENERAL), unstated, zero)[0].probe).toBe(16);
  });

  it("does nothing for a stated age, a rule that failed, or only older tests", () => {
    expect(unstatedAges(ca, held(GENERAL, ABAWD), (slot) => slot === "member_age", zero)).toEqual([]);
    expect(unstatedAges(ca, { [GENERAL]: { kind: "judgment", name: GENERAL, outcome: "not_holds", dependencies: [] } }, unstated, zero)).toEqual([]);
    expect(unstatedAges(ca, held("post_amendment_lawful_permanent_resident_senior_exception"), unstated, zero)).toEqual([]);
  });

  it("gives the ages each result holds for from the tests of the traced rules", () => {
    const traced = new Set([GENERAL, ABAWD]);
    expect(rangeLabel(ageRange(ca, "member_age", traced, 0, 0))).toBe("0 to 15");
    expect(rangeLabel(ageRange(ca, "member_age", traced, 18, 0))).toBe("18 to 59");
    expect(rangeLabel(ageRange(ca, "member_age", traced, 65, 0))).toBe("65 or older");
    // A traced full-time-student child test (under 22) narrows the range.
    traced.add("unmarried_full_time_student_child_under_age_limit");
    expect(rangeLabel(ageRange(ca, "member_age", traced, 18, 0))).toBe("18 to 21");
  });

  it("puts the instruction in the note, not in the system prompt", () => {
    // A sentence about unstated ages in the system prompt reached every
    // question: gpt-6-luna computed an assumed age 30 on plain SNAP
    // questions, and with a clause against that it took 3-6x longer per
    // step on New York ones. The note reaches the model only when the age
    // changed the answer.
    expect(buildSystemPrompt()).not.toMatch(/unstated[- ]age/i);
    const note = unstatedAgeNote(unstatedAges(ca, held(GENERAL, ABAWD), unstated, zero)[0], "snap_benefit", [
      { ages: "0 to 15", outputs: { snap_benefit: 298 } },
      { ages: "18 to 59", outputs: { snap_benefit: 0 } },
    ]);
    expect(note).toBe(
      "NOTE: member 1's member_age was not stated, so it is 0, and 0 passed these age tests: " +
        "snap_member_general_work_requirement_exempt (member_age < 16; 7 CFR 273.7(b)(1)), " +
        "snap_member_abawd_exception_applies (member_age < 18; 7 U.S.C. 2015(o)(3) as amended by P.L. 119-21 section 10102(a)). " +
        "This result holds for member_age 0 to 15; for member_age 18 to 59 it is snap_benefit 0 (applied.unstated_ages). " +
        "If member 1 is an adult, the 0 to 15 result is not theirs: don't present snap_benefit 298 as their amount. " +
        "Give the 18 to 59 result, say the amount depends on their age, and ask their age. " +
        "Don't quote a result for any other age; compute it once the age is known."
    );
  });
});

describe.skipIf(!hasEngine)("unstated ages on the real engine", () => {
  // One adult, $300 unearned income, $600 rent, no work.
  const compute = (slug: string, caseFacts: Facts, age?: number, list = true) => {
    const program = getProgram(slug)!;
    const primary = new Set(program.inputs[program.primary_entity].map((s) => s.name));
    const unearned = ["snap_total_monthly_unearned_income", "other_gain_or_benefit_payments"].find((n) => primary.has(n))!;
    const shelter = ["household_shelter_costs_incurred", "monthly_allowable_shelter_costs"].find((n) => primary.has(n))!;
    const facts: Facts = { household_size: 1, [unearned]: 300, [shelter]: 600 };
    const member: Facts = { ...caseFacts, ...(age === undefined ? {} : { member_age: age }) };
    const members: MemberSpec[] | undefined = list ? [{ facts: member }] : undefined;
    return computeProgram({ program, period: "2026-10", facts: list ? facts : { ...facts, ...member }, members });
  };

  for (const slug of WORK_RULE_STATES) {
    for (const [label, caseFacts] of Object.entries(CASES)) {
      it(`${slug} ${label}: reports the result for an adult when no age is stated`, async () => {
        for (const list of [true, false]) {
          const result = await compute(slug, caseFacts, undefined, list);
          expect(numericOutput(result, "snap_benefit")).toBe(298);
          expect(result.applied.unstated_ages).toEqual([
            {
              member: 1,
              slot: "member_age",
              passed: [
                { rule: GENERAL, tests: ["member_age < 16"], source: "7 CFR 273.7(b)(1)" },
                { rule: ABAWD, tests: ["member_age < 18"], source: "7 U.S.C. 2015(o)(3) as amended by P.L. 119-21 section 10102(a)" },
              ],
              results: [
                { ages: "0 to 15", outputs: { snap_benefit: 298, snap_eligible: "holds" } },
                { ages: "18 to 59", outputs: { snap_benefit: 0, snap_eligible: "not_holds" } },
              ],
            },
          ]);
          const note = result.applied.notes.find((n) => n.startsWith("NOTE: member 1's member_age was not stated"))!;
          expect(note).toContain("for member_age 18 to 59 it is snap_benefit 0, snap_eligible not_holds");
          expect(note).toContain("don't present snap_benefit 298 as their amount");
        }
        // The probe's answer is the engine's own at a stated adult age.
        expect(numericOutput(await compute(slug, caseFacts, 18), "snap_benefit")).toBe(0);
        expect(numericOutput(await compute(slug, caseFacts, 59), "snap_benefit")).toBe(0);
      });
    }

    it(`${slug}: stays quiet when the age is stated or doesn't change the answer`, async () => {
      for (const [age, benefit] of [[35, 0], [65, 298]] as const) {
        const result = await compute(slug, CASES.abawd, age);
        expect(numericOutput(result, "snap_benefit")).toBe(benefit);
        expect(result.applied.unstated_ages).toBeUndefined();
      }
      // Quitting at 60 or older: 273.7(b)(1)(i) exempts the person.
      expect((await compute(slug, CASES.quit, 60)).applied.unstated_ages).toBeUndefined();
      // No work-rule facts: an adult who complies gets the same $298.
      const plain = await compute(slug, {});
      expect(numericOutput(plain, "snap_benefit")).toBe(298);
      expect(plain.applied.unstated_ages).toBeUndefined();
      expect(plain.applied.notes.some((n) => n.includes("was not stated"))).toBe(false);
    });
  }

  it("probes member 1 only", async () => {
    // A stated adult with a child of unstated age: the child's exemption
    // changes nothing, and no other member is probed.
    const program = getProgram("us-ca-snap")!;
    const result = await computeProgram({
      program,
      period: "2026-10",
      facts: { household_size: 2, snap_total_monthly_unearned_income: 300, household_shelter_costs_incurred: 600 },
      members: [{ facts: { member_age: 35 } }, { facts: {} }],
    });
    expect(result.applied.unstated_ages).toBeUndefined();
  });

  it("stays quiet where no age decides the work rules (federal_or_state_minimum_wage defaults to 0)", async () => {
    // 7 CFR 273.7(b)(1)(vii) exempts a person "earning weekly wages at least
    // equal to the Federal minimum wage multiplied by 30 hours". These
    // programs default the wage to 0, so $0 a week meets it at every age.
    for (const slug of ["us-al-snap", "us-fl-snap", "us-ga-snap", "us-ma-snap", "us-nc-snap", "us-sc-snap", "us-tn-snap"]) {
      for (const caseFacts of Object.values(CASES)) {
        const result = await compute(slug, caseFacts);
        expect(numericOutput(result, "snap_benefit"), slug).toBe(298);
        expect(result.applied.unstated_ages, slug).toBeUndefined();
      }
    }
  });
});
