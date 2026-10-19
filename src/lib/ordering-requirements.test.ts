import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import { computeProgram } from "./request-builder";
import { engineAvailable, memberCheck } from "../../scripts/snap-scenarios";

// 26 USC 151(d)(5)(C)(ii): a senior-deduction qualified individual has
// attained age 65. The rule reads the `age` slot, not the EITC's
// `individual_age_at_close_of_calendar_year`. In 1 of 10 live gpt-6-luna runs
// the model set only the lookalike, `age` stayed at its 0 default, and the
// deduction came back $0 — while the failed check's `requires` named only the
// SSN fact, so nothing pointed the model at `age`.
const CHECK = "senior_deduction_qualified_individual";
const AGE_TEST = { slot: "age", op: "gte", value: 65 };
const fiit = getProgram("us-fiit")!;
// "I'm 70 and single, with $100,000 of income in 2026", shaped like the
// failing live call: person facts on member 1, the SSN fact set.
const TAX_UNIT = { adjusted_gross_income: 100000, filing_status: 0, taxpayer_is_individual: true };
const taxpayer = (ageFacts: Record<string, number>) => ({
  facts: { is_taxpayer: true, qualified_individual_social_security_number_included_on_return: true, ...ageFacts },
});
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

describe("ordering tests in judgment requires", () => {
  it("lists the senior deduction's age test with its threshold", () => {
    const output = fiit.outputs.find((o) => o.name === CHECK)!;
    expect(output.requires).toEqual([
      { slot: "qualified_individual_social_security_number_included_on_return", value: true },
      AGE_TEST,
    ]);
    // The taxpayer-or-joint-spouse test is a disjunction: listed as
    // alternatives, so nothing is left beyond the two lists.
    expect(output.requires_any).toEqual([
      {
        rule: CHECK,
        any_of: [
          [{ slot: "is_taxpayer", value: true }],
          [{ slot: "is_spouse_of_taxpayer", value: true }, { slot: "filing_status", value: 1 }],
        ],
      },
    ]);
    expect(output.requires_partial).toBeUndefined();
  });

  it("skips a threshold that changes by period", () => {
    // us-il:statutes/320/30/2: maximum_household_income has seven versions
    // ($40,000 … $79,000), so no single threshold applies to every period.
    const output = getProgram("us-il-scretd")!.outputs.find(
      (o) => o.name === "household_income_no_greater_than_maximum"
    )!;
    expect(output.requires).toBeUndefined();
  });
});

describe.skipIf(!hasEngine)("real-engine senior deduction age requirement", () => {
  const compute = (ageFacts: Record<string, number>) =>
    computeProgram({
      program: fiit,
      period: "2026",
      facts: TAX_UNIT,
      members: [taxpayer(ageFacts)],
      extraOutputs: ["senior_deduction"],
    });
  const seniorDeduction = (result: Awaited<ReturnType<typeof compute>>) =>
    result.outputs.find((o) => o.name === "senior_deduction")?.value;

  it("names `age` as unmet when only the lookalike age slot is set", async () => {
    const result = await compute({ individual_age_at_close_of_calendar_year: 70 });
    const check = memberCheck(result, 1, CHECK);
    expect(check.value).toBe("not_holds");
    expect(check.requires).toContainEqual(AGE_TEST);
    expect(seniorDeduction(result)).toBe(0);
  }, 30_000);

  it("computes $4,500 once `age` is set", async () => {
    const result = await compute({ age: 70 });
    const check = memberCheck(result, 1, CHECK);
    expect(check.value).toBe("holds");
    expect(check.requires).toBeUndefined();
    // $6,000 − 6% × ($100,000 − $75,000) = $4,500 (26 USC 151(d)(5)(C)(iii)).
    expect(seniorDeduction(result)).toBe(4500);
  }, 30_000);
});
