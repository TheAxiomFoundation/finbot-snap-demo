import { getProgram } from "../src/lib/catalog";
import { computeProgram, type Facts } from "../src/lib/request-builder";

const VERDICTS = [
  "snap_member_abawd_exception_applies",
  "snap_member_abawd_time_limit_inapplicable",
  "snap_member_abawd_time_limit_eligible",
  "snap_member_work_requirement_ineligible",
];

async function scenario(label: string, facts: Facts) {
  const program = getProgram("us-ca-snap")!;
  const result = await computeProgram({ program, facts, extraOutputs: VERDICTS });
  console.log(`--- ${label}`);
  for (const name of VERDICTS) {
    const o = result.outputs.find((x) => x.name === name);
    console.log(`  ${name}: ${o?.value}`);
  }
}

async function main() {
  const program = getProgram("us-ca-snap")!;
  const allInputs = Object.values(program.inputs).flat().map((i: any) => i.name);
  console.log("foster input still present:", allInputs.some((n: string) => n.includes("foster")));
  console.log("indian inputs present:", allInputs.filter((n: string) => n.includes("indian")).sort());

  const base = {
    member_medically_certified_physically_or_mentally_unfit_for_employment: false,
    member_is_parent_or_household_member_responsible_for_dependent_child: false,
    member_youngest_dependent_child_age: 0,
    member_is_pregnant: false,
    member_is_indian_or_urban_indian: false,
    member_is_california_indian: false,
    member_age_16_or_17_is_not_household_head_or_attends_school_or_training_half_time: false,
    member_physically_or_mentally_unfit_for_employment: false,
    member_subject_to_and_complying_with_title_iv_work_requirement: false,
    member_responsible_for_dependent_child_under_six_or_incapacitated_person: false,
    member_receiving_or_applying_for_unemployment_compensation_and_complying: false,
    member_regular_participant_in_drug_or_alcohol_treatment: false,
    member_weekly_work_hours: 0,
    member_weekly_wages: 0,
    federal_or_state_minimum_wage: 7.25,
    migrant_or_seasonal_farmworker_under_contract_to_begin_employment_within_30_days: false,
    alaska_subsistence_hunts_or_fishes_30_hours_weekly: false,
    member_student_enrolled_at_least_half_time_and_student_eligible: false,
    member_covered_by_abawd_time_limit_waiver: false,
    member_abawd_weekly_work_hours: 0,
    member_abawd_monthly_work_hours: 0,
    member_participates_in_abawd_work_program_20_hours_weekly: false,
    member_combines_work_and_work_program_20_hours_weekly: false,
    member_participates_in_abawd_workfare_program: false,
    snap_abawd_countable_months_in_three_year_period: 4,
    member_regained_abawd_eligibility: false,
    member_has_additional_three_month_abawd_eligibility: false,
    member_snap_work_requirements_waived_due_to_pending_ssi_joint_application: false,
    member_registered_for_work_or_registered_by_state: true,
    member_participated_in_snap_et_if_assigned: true,
    member_participated_in_workfare_if_assigned: true,
    member_provided_employment_status_or_availability_information: true,
    member_reported_to_referred_suitable_employer_if_referred: true,
    member_accepted_bona_fide_suitable_employment_offer_if_offered: true,
    member_voluntarily_quit_or_reduced_work_below_30_hours_without_good_cause: false,
  };

  await scenario("Cody scenario 1: age 55, zero work, months exhausted", { ...base, member_age: 55 });
  await scenario("Cody scenario 2 equivalent: age 23 former-foster demographic, no exception", { ...base, member_age: 23 });
  await scenario("control: age 65 (excepted under USDA operational reading)", { ...base, member_age: 65 });
}
main();
