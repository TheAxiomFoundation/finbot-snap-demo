/**
 * Client-safe metadata about CO SNAP outputs. Lives in its own module so the
 * chat surface can import it without dragging the engine adapter (which uses
 * node:child_process) into the browser bundle.
 */

/** One-line explanations of how each surface output is computed. Shown as a
 *  subtitle under the value in the chat tool card. Phrases are kept short
 *  enough that they don't reflow the grid; they're a glance, not a treatise. */
export const SURFACE_OUTPUT_DESCRIPTIONS: Record<string, string> = {
  snap_eligible: "Composite — true when income, resource, work, and residency tests all pass",
  snap_income_eligible: "Passes both gross- and net-income tests for the household size",
  snap_resource_eligible: "Countable cash and assets are below the SNAP asset limit",
  snap_work_requirement_eligible: "Every adult member meets or is exempt from the SNAP work rules",
  snap_residency_citizenship_eligible: "State resident with at least one citizen-or-eligible-alien member",
  snap_regular_month_allotment: "Max allotment − 30% of net income; the actual monthly benefit",
  snap_allotment: "Final after Colorado proration; equals regular allotment except in initial month",
  snap_maximum_allotment: "USDA Thrifty Food Plan ceiling for household size (FY 2026 table)",
  gross_income: "All earned + unearned monthly income, before any deductions",
  snap_net_income: "Gross income minus standard, earned-income, and excess-shelter deductions",
  snap_standard_utility_allowance: "Flat utility cost used when the household pays heating/cooling separately",
  snap_standard_deduction: "Flat USDA deduction by household size ($209 for sizes 1–3, FY 2026)",
  snap_earned_income_deduction: "20% of earned income; never applied to unearned income",
  excess_shelter_deduction: "Shelter costs above 50% of adjusted gross income, capped for non-elderly households",
  shelter_costs: "Out-of-pocket rent or mortgage plus the utility allowance",
};
