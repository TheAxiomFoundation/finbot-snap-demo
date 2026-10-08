/** Read-only amount trace. Every value below is queried from the pinned engine.
 * Run with the engine environment, then inspect docs/bbce-evidence/snap-gap-axiom.json.
 */
import { writeFileSync } from "node:fs";
import { getProgram } from "../src/lib/catalog";
import { buildRequest, shapeResult, type Facts } from "../src/lib/request-builder";
import { fact, runCompiled } from "../src/lib/engine";

const rows: object[] = [];
async function main() {
for (const slug of ["us-ca-snap", "us-co-snap"]) {
  const program = getProgram(slug)!;
  const ca = slug === "us-ca-snap";
  for (const period of ["2026-09", "2026-10"]) {
    for (const heating of [undefined, false, true]) {
      const facts: Facts = {
        household_size: 3,
        household_shelter_costs_incurred: 1800,
        [ca ? "snap_gross_monthly_earned_income" : "snap_countable_earned_income"]: 3300,
      };
      if (heating !== undefined) facts[ca
        ? "household_has_heating_and_cooling_costs_separate_from_rent_or_mortgage"
        : "household_incurred_or_anticipated_heating_or_cooling_costs_separate_from_rent_or_mortgage"] = heating;
      const names = ["snap_eligible", "snap_benefit", "snap_maximum_allotment",
        "snap_standard_deduction", "snap_total_gross_income", "snap_earned_income_deduction",
        "snap_net_income_pre_shelter", "snap_net_income", "snap_net_income_for_allotment",
        "snap_standard_utility_allowance", "snap_total_allowable_shelter_expenses",
        "snap_excess_shelter_deduction", "snap_allotment_before_minimum", "snap_regular_month_allotment",
        "snap_net_monthly_income", "snap_excess_shelter_deduction_for_net_income"];
      const built = buildRequest({ program, period, facts,
        members: [35, 8, 5].map(member_age => ({ facts: { member_age, member_is_us_citizen: true } })),
        extraOutputs: names.filter(n => program.outputs.some(o => o.name === n)),
      });
      // Deliberate diagnostic only: bypass assistant input guards to compare
      // arithmetic on eligible households. CO's flag is unsafe as a default.
      const gate = ca ? "household_was_issued_pub_275" : "snap_expanded_categorical_eligible";
      for (const input of built.request.dataset.inputs) {
        if (input.name.endsWith(`#input.${gate}`)) input.value = fact(true, "bool");
      }
      const result = shapeResult(program, built, await runCompiled(slug, built.request));
      const values = Object.fromEntries(result.outputs.filter(o => names.includes(o.name)).map(o => [o.name, o.value]));
      const row = { program: slug, period, heating: heating ?? "default", diagnostic_gate: { [gate]: true }, facts, values };
      rows.push(row);
      writeFileSync("docs/bbce-evidence/snap-gap-axiom.json", JSON.stringify({ rows }, null, 2) + "\n");
      console.log(JSON.stringify(row));
    }
  }
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
