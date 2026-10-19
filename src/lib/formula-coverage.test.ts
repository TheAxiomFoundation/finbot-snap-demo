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

});
