import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import { computeProgram, type MemberSpec } from "./request-builder";
import { engineAvailable, memberCheck, numericOutput } from "../../scripts/snap-scenarios";

// 26 USC 152(c)(3): `age_requirements_met` is a disjunction — permanently and
// totally disabled, OR younger than the taxpayer AND (under 19 OR a student
// under 24). `requires` only lists an unconditional `and` chain, so before
// `requires_any` nothing named `individual_is_younger_than_taxpayer`; in live
// gpt-6-luna runs it stayed at its false default and the children failed
// `eitc_qualifying_child`, giving $0 EITC.
const fiit = getProgram("us-fiit")!;
const AGE_ALTERNATIVES = {
  rule: "age_requirements_met",
  any_of: [
    [{ slot: "individual_is_permanently_and_totally_disabled", value: true }],
    [
      { slot: "individual_is_younger_than_taxpayer", value: true },
      { slot: "individual_age_at_close_of_calendar_year", op: "lt", value: 19 },
    ],
    [
      { slot: "individual_is_younger_than_taxpayer", value: true },
      { slot: "individual_is_student", value: true },
      { slot: "individual_age_at_close_of_calendar_year", op: "lt", value: 24 },
    ],
  ],
};
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

describe("disjunctive alternatives in the catalog", () => {
  const output = (name: string) => fiit.outputs.find((o) => o.name === name)!;

  it("lists age_requirements_met's alternatives in disjunctive normal form", () => {
    const age = output("age_requirements_met");
    expect(age.requires).toBeUndefined();
    expect(age.requires_any).toEqual([AGE_ALTERNATIVES]);
    // The whole rule is captured.
    expect(age.requires_partial).toBeUndefined();
  });

  it("carries the sub-rule's alternatives up to the EITC qualifying-child gate", () => {
    const gate = output("eitc_qualifying_child");
    expect(gate.requires_any).toContainEqual(AGE_ALTERNATIVES);
    expect(gate.requires_any?.map((a) => a.rule)).toContain("qualifying_child_relationship");
    // The tiebreaker and joint-return tests are still beyond both lists.
    expect(gate.requires_partial).toBe(true);
  });
});

describe.skipIf(!hasEngine)("real-engine EITC age alternatives", () => {
  // The member-checks HoH case: kids 8 and 5, $40,000 wages, 2026. The child
  // facts are the live run's: the age went in the age-at-close-of-year slot,
  // and nothing set individual_is_younger_than_taxpayer.
  const child = (age: number, extra: Record<string, boolean> = {}): MemberSpec => ({
    facts: {
      individual_age_at_close_of_calendar_year: age,
      qualifying_child_principal_place_of_abode_is_in_united_states: true,
      qualifying_child_name_age_and_tin_included_on_return: true,
      individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
      individual_principal_place_of_abode_with_taxpayer_fraction: 1,
      individual_own_support_fraction_provided_by_individual: 0,
      ...extra,
    },
  });
  const compute = (extra?: Record<string, boolean>) =>
    computeProgram({
      program: fiit,
      period: "2026",
      facts: {
        filing_status: 3,
        adjusted_gross_income: 40000,
        taxable_income: 15850,
        employee_compensation_includible_in_gross_income: 40000,
        taxpayer_includes_required_social_security_number_on_return: true,
      },
      members: [{ facts: { age: 34 } }, child(8, extra), child(5, extra)],
    });

  it("names individual_is_younger_than_taxpayer when only the age is set", async () => {
    const result = await compute();
    const gate = memberCheck(result, 2, "eitc_qualifying_child");
    expect(gate.value).toBe("not_holds");
    // Only the unmet `or` is shown: the relationship test and the gate's own
    // marital-status test already hold on the recorded facts.
    expect(gate.requires_any).toEqual([AGE_ALTERNATIVES]);
    expect(numericOutput(result, "eitc")).toBe(0);
  }, 30_000);

  it("gives $3,923 once individual_is_younger_than_taxpayer is set", async () => {
    const result = await compute({ individual_is_younger_than_taxpayer: true });
    const gate = memberCheck(result, 2, "eitc_qualifying_child");
    expect(gate.value).toBe("holds");
    expect(gate.requires_any).toBeUndefined();
    expect(memberCheck(result, 3, "eitc_qualifying_child").value).toBe("holds");
    expect(Math.round(numericOutput(result, "eitc"))).toBe(3923);
  }, 30_000);
});
