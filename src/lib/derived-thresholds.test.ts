import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import { computeProgram, type MemberSpec } from "./request-builder";
import { engineAvailable, memberCheck, numericOutput } from "../../scripts/snap-scenarios";

// 26 USC 152(c)(1)(B): a qualifying child has the same principal place of
// abode as the taxpayer for more than one-half of the year. The rule compares
// `individual_principal_place_of_abode_with_taxpayer_fraction` against
// `abode_fraction_threshold`, a derived rule whose expression is `1 / 2`.
// Before the generator folded constant rules, that comparison fell to
// `requires_partial` and nothing named the abode slot. In 4 of 35 live
// gpt-6-luna EITC runs the model set the age group on each child, recomputed,
// and the child still failed `eitc_qualifying_child` with the abode fraction
// at its 0 default.
const fiit = getProgram("us-fiit")!;
const ABODE_TEST = { slot: "individual_principal_place_of_abode_with_taxpayer_fraction", op: "gt", value: 0.5 };
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

describe("ordering tests against constant derived thresholds", () => {
  const output = (name: string) => fiit.outputs.find((o) => o.name === name)!;

  it("lists the abode-fraction test on the EITC qualifying-child gates", () => {
    expect(output("eitc_qualifying_child_base").requires).toEqual([ABODE_TEST]);
    expect(output("eitc_qualifying_child").requires).toContainEqual(ABODE_TEST);
  });

  it("lists the abode and support tests on the 152(c) qualifying child", () => {
    // 152(c)(1)(D): the child has not provided over one-half of their own
    // support (`support_fraction_threshold`, also `1 / 2`).
    const requires = output("qualifying_child_before_tiebreaker").requires;
    expect(requires).toContainEqual(ABODE_TEST);
    expect(requires).toContainEqual({
      slot: "individual_own_support_fraction_provided_by_individual",
      op: "lte",
      value: 0.5,
    });
  });

  it("folds arithmetic over single-valued parameters", () => {
    // 10 CCR 2506-1 section 4.205.4: two 30-day processing periods, 30 + 30.
    const co = getProgram("us-co-snap")!.outputs.find(
      (o) => o.name === "application_process_exceeded_second_thirty_day_period"
    )!;
    expect(co.requires).toContainEqual({ slot: "application_processing_days_elapsed", op: "gt", value: 60 });
  });
});

describe.skipIf(!hasEngine)("real-engine EITC abode-fraction requirement", () => {
  // The member-checks HoH case: kids 8 and 5, $40,000 wages, 2026. The age
  // group from `requires_any` is set; the abode fraction is left out, as in
  // the failing live runs.
  const child = (age: number, extra: Record<string, number> = {}): MemberSpec => ({
    facts: {
      individual_age_at_close_of_calendar_year: age,
      individual_is_younger_than_taxpayer: true,
      qualifying_child_principal_place_of_abode_is_in_united_states: true,
      qualifying_child_name_age_and_tin_included_on_return: true,
      individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
      ...extra,
    },
  });
  const compute = (extra?: Record<string, number>) =>
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

  it("names the abode fraction when it is unset", async () => {
    const result = await compute();
    const gate = memberCheck(result, 2, "eitc_qualifying_child");
    expect(gate.value).toBe("not_holds");
    expect(gate.requires).toContainEqual(ABODE_TEST);
    // Every `or` already holds, so before this the abode test was not in
    // either list.
    expect(gate.requires_any).toBeUndefined();
    expect(gate.failed_because?.map((f) => f.name)).toContain("eitc_qualifying_child_base");
    expect(numericOutput(result, "eitc")).toBe(0);
  }, 30_000);

  it("gives $3,923 once the abode fraction is 1", async () => {
    const result = await compute({ individual_principal_place_of_abode_with_taxpayer_fraction: 1 });
    const gate = memberCheck(result, 2, "eitc_qualifying_child");
    expect(gate.value).toBe("holds");
    expect(gate.requires).toBeUndefined();
    expect(memberCheck(result, 3, "eitc_qualifying_child").value).toBe("holds");
    expect(Math.round(numericOutput(result, "eitc"))).toBe(3923);
  }, 30_000);
});
