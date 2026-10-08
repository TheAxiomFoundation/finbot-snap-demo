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
 * 4. us-al-snap — elderly/disabled households skip the gross income test but
 *    must still pass the net test (7 CFR 273.9(a)(2); AL DHR POE 900). One
 *    person, FY2026 standards: $209 standard deduction, $35 medical threshold,
 *    $1,305 net limit, $298 maximum, $24 minimum. $4,004 earned (307% of the
 *    2025 guideline) nets $2,995 → not eligible; $1,174 earned (90%) with $300
 *    medical nets $466 → eligible, $158. $1,600 unearned nets $1,391 → not
 *    eligible, and $300 medical takes it to $1,126 → eligible at the $24
 *    minimum, so the medical deduction alone decides the net test.
 *
 * Run: bun run test:regression   (requires local engine or AXIOM_ENGINE_URL)
 */
import assert from "node:assert/strict";

import { getProgram } from "../src/lib/catalog";
import { computeProgram, type Facts } from "../src/lib/request-builder";
import { runBbceRegressions } from "./bbce-regression";
import { SNAP_TEST_PERIOD } from "./snap-scenarios";

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

async function alSnapElderlyDisabledNetTest() {
  const program = getProgram("us-al-snap");
  assert.ok(program, "us-al-snap not in catalog");
  const elderlyOrDisabled = { facts: { member_is_us_citizen: true, member_age: 70, snap_member_is_elderly_or_disabled: true } };
  const cases: Array<{ label: string; facts: Facts; net: number; eligible: string; benefit: number }> = [
    { label: "307% earned, no deductions", facts: { snap_gross_monthly_earned_income: 4004 }, net: 2995, eligible: "not_holds", benefit: 0 },
    { label: "90% earned, $300 medical", facts: { snap_gross_monthly_earned_income: 1174, household_entitled_to_excess_medical_deduction: true, snap_total_medical_expenses: 300 }, net: 466, eligible: "holds", benefit: 158 },
    { label: "$1,600 unearned, no medical", facts: { snap_total_monthly_unearned_income: 1600 }, net: 1391, eligible: "not_holds", benefit: 0 },
    { label: "$1,600 unearned, $300 medical", facts: { snap_total_monthly_unearned_income: 1600, household_entitled_to_excess_medical_deduction: true, snap_total_medical_expenses: 300 }, net: 1126, eligible: "holds", benefit: 24 },
  ];
  for (const c of cases) {
    const result = await computeProgram({
      program,
      period: SNAP_TEST_PERIOD,
      facts: { household_size: 1, ...c.facts },
      members: [elderlyOrDisabled],
      extraOutputs: ["snap_standard_gross_income_eligible", "snap_net_monthly_income"],
    });
    assert.equal(value(result, "snap_standard_gross_income_eligible"), "holds", `${c.label}: gross test exempt`);
    assert.equal(value(result, "snap_net_monthly_income"), c.net, `${c.label}: net income`);
    assert.equal(value(result, "snap_eligible"), c.eligible, `${c.label}: eligibility`);
    assert.equal(value(result, "snap_benefit"), c.benefit, `${c.label}: benefit`);
    console.log(`ok   us-al-snap elderly/disabled, ${c.label}: net $${c.net}, ${c.eligible}, $${c.benefit}`);
  }
}

async function main() {
  await coSnapFixture();
  await fiitCtcMembers();
  await mdTcaLookup();
  await alSnapElderlyDisabledNetTest();
  const failures = await runBbceRegressions("regression");
  assert.equal(failures, 0, "BBCE eligibility/starter regressions failed");
  console.log("\nregression tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
