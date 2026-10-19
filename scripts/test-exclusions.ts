/** California BBCE exclusions: with the PUB 275 default on, a 1-person
 * household at 145% of the poverty line is eligible, and each member or
 * household exclusion must still deny it. Some exclusions only take effect
 * with a companion input (a work sanction applies to the household head; the
 * student rule needs half-time enrollment in a degree program), so those
 * cases set both. Needs the engine.
 */
import { getProgram } from "../src/lib/catalog";
import { runCompiled } from "../src/lib/engine";
import { buildRequest, shapeResult } from "../src/lib/request-builder";
import { checkpoint, CHECKPOINT_DIR, skipWithoutEngine } from "./snap-scenarios";

const PERIOD = "2026-09";
const EARNED = Math.ceil((15650 / 12) * 1.45);

const CASES: Array<{ label: string; household?: Record<string, boolean>; member?: Record<string, boolean | number>; expect: "holds" | "not_holds" }> = [
  { label: "control (no exclusion)", expect: "holds" },
  { label: "intentional program violation", member: { member_disqualified_for_intentional_program_violation: true }, expect: "not_holds" },
  { label: "noncitizen without qualifying status", member: { member_is_us_citizen: false }, expect: "not_holds" },
  { label: "student (half-time, degree program, age 20)", member: { enrolled_at_least_half_time: true, enrolled_in_college_or_university_degree_program: true, student_age: 20, member_age: 20 }, expect: "not_holds" },
  { label: "household head work sanction", member: { member_is_household_head: true, member_disqualified_for_work_requirement_noncompliance: true }, expect: "not_holds" },
  { label: "entire household workfare disqualification", household: { entire_household_disqualified_for_workfare_noncompliance: true }, expect: "not_holds" },
  { label: "fleeing felon", member: { member_is_fleeing_felon: true }, expect: "not_holds" },
  { label: "SSN refusal", member: { member_refused_or_failed_to_provide_or_apply_for_ssn: true }, expect: "not_holds" },
  { label: "nonexempt institution", member: { member_is_institutionalized_in_nonexempt_facility: true }, expect: "not_holds" },
];

async function main() {
  if (skipWithoutEngine("test:exclusions")) {
    checkpoint("exclusions", { status: "skipped" });
    return;
  }
  const program = getProgram("us-ca-snap")!;
  const slots = new Set(Object.values(program.inputs).flat().map((s) => s.name));
  const rows: Array<Record<string, unknown>> = [];
  let failures = 0;
  for (const c of CASES) {
    for (const name of [...Object.keys(c.household ?? {}), ...Object.keys(c.member ?? {})]) {
      if (!slots.has(name)) throw new Error(`us-ca-snap has no input ${name}; update this test`);
    }
    const built = buildRequest({
      program, period: PERIOD, mode: "explain",
      facts: { household_size: 1, snap_gross_monthly_earned_income: EARNED, household_shelter_costs_incurred: 1800, ...(c.household ?? {}) },
      members: [{ facts: { member_is_us_citizen: true, member_age: 30, ...(c.member ?? {}) } }],
    });
    const result = shapeResult(program, built, await runCompiled(program.slug, built.request));
    const eligible = result.outputs.find((o) => o.name === "snap_eligible")?.value;
    const benefit = result.outputs.find((o) => o.name === "snap_benefit")?.value;
    const ok = eligible === c.expect;
    if (!ok) failures++;
    rows.push({ label: c.label, expect: c.expect, eligible, benefit, ok });
    console.log(`${ok ? "ok  " : "FAIL"} CA 1p 145% ${c.label}: ${eligible}, $${benefit} (expected ${c.expect})`);
  }
  checkpoint("exclusions", { period: PERIOD, earned: EARNED, rows, failures });
  console.log(`\nexclusions: ${CASES.length - failures}/${CASES.length} as expected. Checkpoint: ${CHECKPOINT_DIR}/exclusions.json`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
