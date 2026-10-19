import { describe, expect, it } from "vitest";
import { BBCE_STARTERS, STARTERS } from "../src/lib/starters";
import { computeProgram } from "../src/lib/request-builder";
import { engineAvailable, numericOutput, output, starterScenario, STARTER_FIXTURES } from "./snap-scenarios";

describe("BBCE starter candidates", () => {
  it("features one TANF starter and one federal tax starter", () => {
    expect(STARTERS.filter((s) => s.includes("TANF"))).toHaveLength(1);
    expect(STARTERS.some((s) => s.includes("EITC"))).toBe(true);
    expect(STARTERS.some((s) => s.includes("New York"))).toBe(false);
  });

  it("stays between 130% and 200% under both poverty guideline years", () => {
    // ASPE primary source: 2026 Poverty Guidelines Computations, which also
    // lists the corresponding 2025 guideline ($26,650 for three people).
    // https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/prior-hhs-poverty-guidelines-federal-register-references/2026-poverty-guidelines-computations
    for (const annualFpl of [26650, 27320]) {
      expect(3400 * 12 / annualFpl).toBeGreaterThan(1.3);
      expect(3400 * 12 / annualFpl).toBeLessThan(2);
    }
    expect(BBCE_STARTERS).toHaveLength(1);
    expect(BBCE_STARTERS[0]).toContain("$3,400");
    expect(BBCE_STARTERS[0]).toContain("$1,500 rent");
    expect(BBCE_STARTERS[0]).toContain("including heat");
  });
});

describe.skipIf(!engineAvailable())("real-engine starter outputs", () => {
  for (const fixture of STARTER_FIXTURES) {
    it(`${fixture.state} family3: ${fixture.expectedBenefit} under encoded FY2026 standards`, async () => {
      const result = await computeProgram(starterScenario(fixture.state));
      expect(output(result, "snap_eligible")).toBe("holds");
      expect(numericOutput(result, "snap_benefit")).toBe(fixture.expectedBenefit);
    });
  }
});
