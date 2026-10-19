/** Reproduce the before/after table with the real engine, without any model calls. */
import { writeFileSync } from "node:fs";
import { getCatalog } from "../src/lib/catalog";
import { fact, runCompiled } from "../src/lib/engine";
import { buildRequest, shapeResult, type Facts } from "../src/lib/request-builder";

async function main() {
  const rows: object[] = [];
  for (const program of getCatalog().programs.filter(p => p.program_id === "snap")) {
    const slots = new Set(Object.values(program.inputs).flat().map(s => s.name));
    const facts: Facts = { household_size: 3 };
    for (const [name, value] of Object.entries({
      household_shelter_costs_incurred: 1800, monthly_allowable_shelter_costs: 1800,
      snap_gross_monthly_earned_income: 3300, snap_countable_earned_income: 3300,
      budgetary_unit_participant_count: 3, az_utility_allowance_participant_count: 3,
      assistance_group_size: 3,
    })) if (slots.has(name)) facts[name] = value;
    const options = { program, period: "2026-10", facts,
      members: [35, 8, 5].map(member_age => ({ facts: { member_age, member_is_us_citizen: true } })),
    };
    const read = (result: ReturnType<typeof shapeResult>) => ({
      benefit: result.outputs.find(o => o.name === program.primary_output)?.value,
      eligibility: result.outputs.find(o => o.name === "snap_eligible")?.value,
    });
    const beforeBuilt = buildRequest(options);
    // Restore only the three pre-fix input values; baseline differences are
    // input plumbing, while the artifact and engine stay identical.
    const baseline = ["household_was_issued_pub_275", "snap_expanded_categorical_eligible",
      "household_has_earned_income_budgeted_for_snap"];
    for (const input of beforeBuilt.request.dataset.inputs) {
      if (baseline.some(name => input.name.endsWith(`#input.${name}`))) input.value = fact(false, "bool");
    }
    const before = read(shapeResult(program, beforeBuilt, await runCompiled(program.slug, beforeBuilt.request)));
    const afterBuilt = buildRequest(options);
    const afterResult = shapeResult(program, afterBuilt, await runCompiled(program.slug, afterBuilt.request));
    const row = { program: program.slug, period: options.period, facts, before,
      after: read(afterResult), notes: afterResult.applied.notes };
    rows.push(row);
    writeFileSync(".cache/bbce/before-after.json", JSON.stringify({ rows }, null, 2) + "\n");
    console.log(JSON.stringify(row));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
