import { describe, expect, it } from "vitest";

import { getProgram, slotDefaultAt } from "./catalog";
import { describeProgramPayload } from "./describe";
import { buildRequest, computeProgram } from "./request-builder";
import { engineAvailable } from "../../scripts/snap-scenarios";

// 26 USC 151(d)(5)(C)(i) (P.L. 119-21): the senior deduction applies to "a
// taxable year beginning before January 1, 2029". In 1 of 10 live runs the
// model left this fact at its old false default and the reply withheld $4,500.
const SLOT = "taxable_year_begins_before_senior_deduction_termination";
const fiit = getProgram("us-fiit")!;
// "I'm 70 and single, with $100,000 of income": everything the deduction
// needs except the termination-date fact, which is left to the default.
const QUALIFIED_FILER = {
  adjusted_gross_income: 100000,
  filing_status: 0,
  taxpayer_is_individual: true,
  is_taxpayer: true,
  age: 70,
  qualified_individual_social_security_number_included_on_return: true,
};
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

function slotRecords(built: ReturnType<typeof buildRequest>) {
  return built.request.dataset.inputs.filter((i) => i.name.endsWith(`#input.${SLOT}`));
}

describe("period-aware overlay defaults", () => {
  it("defaults the senior deduction's termination test from the period's start", () => {
    const slot = fiit.inputs.TaxUnit.find((s) => s.name === SLOT)!;
    expect(slot).toMatchObject({
      default: true,
      default_source: "overlay",
      default_by_period: { before: "2029-01-01", otherwise: false },
    });
    expect(slotDefaultAt(slot, "2028-12-01")).toBe(true);
    expect(slotDefaultAt(slot, "2029-01-01")).toBe(false);
    for (const [period, expected] of [["2025", true], ["2026", true], ["2028", true], ["2029", false], ["2031", false]] as const) {
      const built = buildRequest({ program: fiit, period, facts: QUALIFIED_FILER });
      expect(slotRecords(built).length).toBeGreaterThan(0);
      expect(slotRecords(built).every((i) => i.value.value === expected)).toBe(true);
      // Disclosed like every other overlay default, with the period's value.
      expect(built.applied.overlay_defaults_in_effect?.[SLOT]).toBe(expected);
    }
  });

  it("keeps a caller's value and leaves it out of the disclosure", () => {
    const built = buildRequest({ program: fiit, period: "2026", facts: { ...QUALIFIED_FILER, [SLOT]: false } });
    expect(slotRecords(built).every((i) => i.value.value === false)).toBe(true);
    expect(built.applied.overlay_defaults_in_effect?.[SLOT]).toBeUndefined();
  });

  it("shows describe_program the default for its default period", () => {
    const payload = describeProgramPayload(fiit);
    expect(payload.default_period < "2029").toBe(true);
    expect(payload.default_overrides?.[SLOT]).toBe(true);
    expect(payload.inputs.TaxUnit.slots).toContain(`${SLOT}:bool=true`);
  });
});

describe.skipIf(!hasEngine)("real-engine senior deduction without the termination fact", () => {
  it("computes $4,500 for 2026 and $0 for 2029", async () => {
    const seniorDeduction = async (period: string, options: { outputsOverride?: string[]; extraOutputs?: string[] }) => {
      const result = await computeProgram({ program: fiit, period, facts: QUALIFIED_FILER, ...options });
      return result.outputs.find((o) => o.name === "senior_deduction")?.value;
    };
    // $6,000 − 6% × ($100,000 − $75,000) = $4,500 (26 USC 151(d)(5)(C)(iii)).
    expect(await seniorDeduction("2026", { extraOutputs: ["senior_deduction"] })).toBe(4500);
    // The headline income-tax rules have no formula version for 2029 in
    // this release, so read the deduction alone (the lookup_value path).
    expect(await seniorDeduction("2029", { outputsOverride: ["senior_deduction"] })).toBe(0);
  }, 30_000);
});
