import { describe, expect, it } from "vitest";

import { getProgram, slotDefaultAt } from "./catalog";
import { describeProgramPayload } from "./describe";
import { buildRequest, computeProgram } from "./request-builder";
import { engineAvailable } from "../../scripts/snap-scenarios";

// 26 USC 151(d)(5)(A): "In the case of a taxable year beginning after December
// 31, 2017", the exemption amount "means zero". The encoding takes that date
// test as an input. At its old false default, exemption_amount read the $2,000
// base: lookup_value gave $2,000 for 2026, and §55 added $2,000 per exemption
// back into amt_income.
const SLOT = "taxable_year_begins_after_exemption_amount_zero_start";
const fiit = getProgram("us-fiit")!;
// A single itemizer inside the §55 verified domain with $100,000 of
// private-activity bond interest, who claims their own exemption. Everything
// except the date fact, which is left to the default.
const AMT_FILER = {
  taxpayer_is_individual: true,
  filing_status: 0,
  tax_unit_itemizes: true,
  taxable_income: 250000,
  salt_deduction: 40000,
  completed_section_57_a_5_specified_private_activity_bond_interest: 100000,
  section_26_b_regular_tax_liability_before_credits: 56000,
  no_other_section_56_adjustment: true,
  no_other_section_59_special_rule_affects_completed_individual_amt: true,
  section_57_a_1_depletion_preference_is_zero: true,
  section_57_a_2_intangible_drilling_cost_preference_is_zero: true,
  section_57_a_5_completed_interest_domain_is_satisfied: true,
  section_57_a_6_pre_1987_depreciation_or_amortization_preference_is_zero: true,
  section_57_a_7_small_business_stock_preference_is_zero: true,
  section_58_a_completed_loss_domain_is_satisfied: true,
  section_58_b_completed_loss_domain_is_satisfied: true,
  section_58_c_1_completed_insolvency_domain_is_satisfied: true,
  section_58_c_2_completed_disposition_domain_is_satisfied: true,
  section_59_a_completed_credit_domain_is_satisfied: true,
  section_59_e_completed_adjustment_domain_is_satisfied: true,
  section_59_g_completed_adjustment_domain_is_satisfied: true,
  section_59_h_completed_adjustment_domain_is_satisfied: true,
};
const AMT_MEMBERS = [{ facts: { is_taxpayer: true, age: 45, tin_included_on_return_claiming_exemption: true } }];
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

function slotRecords(built: ReturnType<typeof buildRequest>) {
  return built.request.dataset.inputs.filter((i) => i.name.endsWith(`#input.${SLOT}`));
}

describe("§151(d)(5)(A) zero-exemption default", () => {
  it("is true for taxable years beginning after 2017", () => {
    const slot = fiit.inputs.TaxUnit.find((s) => s.name === SLOT)!;
    expect(slot).toMatchObject({
      default: false,
      default_source: "overlay",
      default_by_period: { before: "2018-01-01", otherwise: true },
    });
    expect(slotDefaultAt(slot, "2017-01-01")).toBe(false);
    expect(slotDefaultAt(slot, "2018-01-01")).toBe(true);
    for (const period of ["2026", "2027", "2030"]) {
      const built = buildRequest({ program: fiit, period, facts: AMT_FILER, members: AMT_MEMBERS });
      expect(slotRecords(built).length).toBeGreaterThan(0);
      expect(slotRecords(built).every((i) => i.value.value === true)).toBe(true);
      expect(built.applied.overlay_defaults_in_effect?.[SLOT]).toBe(true);
    }
  });

  it("keeps a caller's value and leaves it out of the disclosure", () => {
    const built = buildRequest({ program: fiit, period: "2026", facts: { ...AMT_FILER, [SLOT]: false }, members: AMT_MEMBERS });
    expect(slotRecords(built).every((i) => i.value.value === false)).toBe(true);
    expect(built.applied.overlay_defaults_in_effect?.[SLOT]).toBeUndefined();
  });

  it("shows describe_program true for its default period", () => {
    const payload = describeProgramPayload(fiit);
    expect(payload.default_overrides?.[SLOT]).toBe(true);
    expect(payload.inputs.TaxUnit.slots).toContain(`${SLOT}:bool=true*`);
  });
});

describe.skipIf(!hasEngine)("real-engine exemption amount without the date fact", () => {
  it("looks up a $0 exemption amount for 2026", async () => {
    const result = await computeProgram({ program: fiit, period: "2026", facts: {}, outputsOverride: ["exemption_amount"] });
    expect(result.outputs.find((o) => o.name === "exemption_amount")?.value).toBe(0);
  }, 30_000);

  it("adds no exemption back into 2026 AMT income", async () => {
    const result = await computeProgram({
      program: fiit,
      period: "2026",
      facts: AMT_FILER,
      members: AMT_MEMBERS,
      extraOutputs: ["section_55_verified_domain_is_satisfied", "section_151_exemption_deduction", "amt_income"],
    });
    const value = (name: string) => result.outputs.find((o) => o.name === name)?.value;
    expect(value("section_55_verified_domain_is_satisfied")).toBe("holds");
    expect(value("section_151_exemption_deduction")).toBe(0);
    // $250,000 taxable income + $40,000 SALT + $100,000 bond interest.
    expect(value("amt_income")).toBe(390000);
    // ($390,000 − $90,100 exemption) → 26% × $244,500 + 28% × $55,400
    // = $79,082 tentative minimum tax, less $56,000 regular tax. The old
    // default gave $23,642 (+28% × $2,000).
    expect(value("alternative_minimum_tax")).toBe(23082);
  }, 30_000);
});
