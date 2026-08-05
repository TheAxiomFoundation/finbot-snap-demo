/**
 * Exact-value regression cases pinned against the current release.
 *
 * 1. us-co-snap — reproduces the corpus composition fixture
 *    (us-co/policies/cdhs/snap/fy-2026-benefit-calculation.test.yaml case 1):
 *    1-person household, $1,000/month earned income, $500 shelter with
 *    separate heating → $298 regular monthly allotment, eligible. Those
 *    fixture inputs are the catalog's mined defaults, so pure defaults must
 *    reproduce the fixture's expected outputs.
 * 2. us-fiit — married-joint scenario exercising members[].relations: two
 *    subsection-h-qualifying children linked through
 *    ctc_qualifying_child_of_tax_unit + dependent_of_tax_unit →
 *    CTC = 2 × $2,200 = $4,400, and the $95k taxable-income tax figure.
 *    Since program-artifacts-4755928bfb8a the federal pipeline selects
 *    brackets by filing_status (1 = joint), so the case pins the joint
 *    schedule: regular_tax_before_credits = $10,904 on $95k taxable
 *    (the July release's single-schedule $15,612 predates that machinery),
 *    and income_tax_before_credits moved into the acknowledged-incomplete
 *    section 55 wrapper, so the regular-tax figure is the pinned one.
 * 3. us-md-tca — TANF-family lookup: household of 3 → $773/month maximum
 *    benefit per the FIA IM 26-13 Allowable TCA Monthly Payment schedule.
 *
 * Run: bun run test:regression   (requires local engine or AXIOM_ENGINE_URL)
 */
import assert from "node:assert/strict";

import { getProgram } from "../src/lib/catalog";
import { computeProgram } from "../src/lib/request-builder";

function value(result: Awaited<ReturnType<typeof computeProgram>>, name: string) {
  const output = result.outputs.find((o) => o.name === name);
  assert.ok(output, `${name} missing from result`);
  return output.value;
}

async function coSnapFixture() {
  const program = getProgram("us-co-snap");
  assert.ok(program, "us-co-snap not in catalog");
  const result = await computeProgram({
    program,
    extraOutputs: ["snap_regular_month_allotment", "snap_maximum_allotment"],
  });
  assert.equal(value(result, "snap_eligible"), "holds");
  assert.equal(value(result, "snap_benefit"), 298);
  assert.equal(value(result, "snap_regular_month_allotment"), 298);
  assert.equal(value(result, "snap_maximum_allotment"), 298);
  console.log("ok   us-co-snap fixture: $298 allotment, eligible");
}

async function fiitCtcMembers() {
  const program = getProgram("us-fiit");
  assert.ok(program, "us-fiit not in catalog");
  const child = {
    facts: {
      age: 8,
      ctc_child_deduction_allowed: true,
      ctc_child_satisfies_subsection_c: true,
      ctc_child_satisfies_dependency_rules: true,
      qualifying_child_name_age_and_tin_included_on_return: true,
      qualifying_child_ssn_included_on_return: true,
      qualifying_child_ssn_is_valid_for_subsection_h: true,
      taxpayer_or_spouse_ssn_included_on_return: true,
      taxpayer_or_spouse_ssn_is_valid_for_subsection_h: true,
      qualifying_child_tin_included_on_return: true,
      qualifying_child_tin_issued_on_or_before_return_due_date: true,
      qualifying_child_principal_place_of_abode_is_in_united_states: true,
    },
    relations: ["ctc_qualifying_child_of_tax_unit", "dependent_of_tax_unit"],
  };
  const result = await computeProgram({
    program,
    facts: {
      taxable_income: 95000,
      adjusted_gross_income: 110000,
      taxable_year_months: 12,
      ctc_subsection_h_special_rules_apply: true,
      ctc_phaseout_joint_threshold_applies: true,
      filing_status: 1,
    },
    members: [child, child],
    extraOutputs: ["ctc_qualifying_children_count"],
  });
  assert.equal(value(result, "ctc_qualifying_children_count"), 2);
  assert.equal(value(result, "ctc_after_advance_payments"), 4400);
  assert.equal(value(result, "regular_tax_before_credits"), 10904);
  console.log("ok   us-fiit members[].relations: 2 qualifying children, $4,400 CTC");
}

async function mdTcaLookup() {
  const program = getProgram("us-md-tca");
  assert.ok(program, "us-md-tca not in catalog");
  const result = await computeProgram({
    program,
    facts: { household_size: 3 },
  });
  assert.equal(value(result, "md_tca_maximum_monthly_benefit"), 773);
  console.log("ok   us-md-tca: $773 maximum for household of 3");
}

async function main() {
  await coSnapFixture();
  await fiitCtcMembers();
  await mdTcaLookup();
  console.log("\nregression tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
