import { describe, expect, it } from "vitest";
import { engineAvailable } from "../../scripts/snap-scenarios";
import { tools } from "./tools";

const program = "us-ny-snap";
const output = "snap_member_citizenship_or_alien_status_eligible";
const period = "2025-07";
const members = [{ facts: { member_age: 35, member_is_us_citizen: true } }];
const context = { toolCallId: "formula-coverage-test", messages: [] };

const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) throw new Error("REQUIRE_ENGINE=1 but no engine is available");

describe.skipIf(!hasEngine)("missing historical formula coverage", () => {
  it("discloses a July citizenship lookup without returning an eligibility value", async () => {
    const result = await tools.lookup_value.execute!({ program, output, period, members }, context);
    expect(result).toMatchObject({
      kind: "no_formula_version",
      program,
      period,
      output,
      error: `Axiom has no rule in force for ${period} for ${output}.`,
      applied: { disclosures: expect.arrayContaining([`Axiom has no rule in force for ${period} for ${output}.`]) },
    });
    expect(result).not.toHaveProperty("value");
    expect(result).not.toHaveProperty("outputs");
  });

  // The July 2025 net income limit table has no value for a one-person
  // household (#40): a full compute discloses that, never a raw engine error.
  it("discloses a missing historical parameter value on a full July compute", async () => {
    const parameter = "snap_net_income_limit_100_percent_fpl_48_states_dc_table";
    const disclosure = `Axiom has no value in force for ${period} for the parameter ${parameter}.`;
    const result = await tools.compute.execute!({ program, period, members }, context);
    expect(result).toMatchObject({
      kind: "no_parameter_value",
      program,
      period,
      parameter,
      key: 1,
      error: disclosure,
      applied: { disclosures: expect.arrayContaining([disclosure]) },
    });
    expect(result).not.toHaveProperty("outputs");
    expect(result).not.toHaveProperty("primary_output");
  }, 30_000);

});
