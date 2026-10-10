import fc from "fast-check";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import { getCatalog, getProgram } from "./catalog";
import { runCompiled } from "./engine";
import { buildRequest, shapeResult } from "./request-builder";
import { engineAvailable } from "../../scripts/snap-scenarios";

const POVERTY_SLOT = "poverty_income_guideline_for_household_size";
const INDIGENCE_OUTPUT = "indigent_sponsored_alien_unable_to_obtain_food_and_shelter";
const snapPrograms = getCatalog().programs.filter((program) => program.program_id === "snap");
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

describe("household count inputs", () => {
  it("preserves requests across equivalent explicit and synthesized SNAP members without inventing money", () => {
    fc.assert(fc.property(fc.constantFrom(...snapPrograms.map((program) => program.slug)), fc.integer({ min: 1, max: 8 }), (slug, size) => {
      const program = getProgram(slug)!;
      // North Carolina also exposes a separate FNS-unit count. Supply the same
      // factual count through both household representations.
      const facts = { household_size: size, ...(program.slug === "us-nc-snap" && { fns_unit_size: size }) };
      const options = { program, period: "2026-09", facts, outputsOverride: [INDIGENCE_OUTPUT] };
      const synthesized = buildRequest(options);
      const explicit = buildRequest({ ...options, members: Array.from({ length: size }, () => ({})) });
      expect(isDeepStrictEqual(explicit.request, synthesized.request)).toBe(true);
      expect(explicit.applied.facts_applied).not.toHaveProperty(POVERTY_SLOT);
      const povertyRecords = explicit.request.dataset.inputs.filter((record) => record.name.endsWith(`#input.${POVERTY_SLOT}`));
      expect(povertyRecords.length).toBeGreaterThan(0);
      expect(povertyRecords.every((record) => record.value.value === "0")).toBe(true);
    }), { seed: 20261009, numRuns: 50 });
  }, 30_000);

  it("does not use a supplied monetary guideline to synthesize member headcount", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 100000 }), (guideline) => {
      const built = buildRequest({ program: getProgram("us-ny-snap")!, period: "2026-09", facts: { [POVERTY_SLOT]: guideline } });
      expect(built.applied.member_count).toBe(1);
      expect(built.applied.facts_applied[POVERTY_SLOT]).toBe(guideline);
    }), { seed: 20261009, numRuns: 100 });
  });

  it("retains automatic household count from an explicit member list", () => {
    const built = buildRequest({ program: getProgram("us-ny-snap")!, period: "2026-09", members: [{}, {}, {}] });
    expect(built.applied.member_count).toBe(3);
    expect(built.applied.facts_applied.household_size).toBe(3);
    expect(built.applied.facts_applied).not.toHaveProperty(POVERTY_SLOT);
  });
});

describe.skipIf(!hasEngine)("real-engine equivalent household representations", () => {
  it("returns the same indigence judgment with an omitted monetary guideline", async () => {
    const program = getProgram("us-ny-snap")!;
    const options = {
      program, period: "2026-09", outputsOverride: [INDIGENCE_OUTPUT],
      facts: {
        household_size: 1, member_age: 35,
        eligible_sponsored_alien_household_own_monthly_income: 1,
        monthly_cash_contributions_from_sponsor_and_others: 0,
        monthly_value_of_in_kind_assistance_from_sponsor_and_others: 0,
      },
    };
    const synthesized = buildRequest(options);
    const explicit = buildRequest({ ...options, members: [{ facts: { member_age: 35 } }] });
    const synthesizedResult = shapeResult(program, synthesized, await runCompiled(program.slug, synthesized.request));
    const explicitResult = shapeResult(program, explicit, await runCompiled(program.slug, explicit.request));
    expect(explicitResult.outputs).toEqual(synthesizedResult.outputs);
    expect(explicit.request).toEqual(synthesized.request);
    expect(explicitResult.outputs[0].value).toBe("not_holds");
  }, 60_000);
});
