import { describe, expect, it } from "vitest";
import { BBCE_STARTERS, STARTERS } from "../src/lib/starters";
import { getProgram } from "../src/lib/catalog";
import { computeProgram } from "../src/lib/request-builder";
import { engineAvailable, numericOutput, output, starterScenario, STARTER_FIXTURES } from "./snap-scenarios";

describe("BBCE starter candidates", () => {
  it("features one TANF, one federal tax and one SNAP starter", () => {
    expect(STARTERS.filter((s) => s.includes("TANF"))).toHaveLength(1);
    expect(STARTERS.some((s) => s.includes("EITC"))).toBe(true);
    expect(STARTERS.some((s) => s.includes("SNAP"))).toBe(true);
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

describe.skipIf(!engineAvailable())("refugee SNAP starter", () => {
  // P.L. 119-21 §10108: refugee status alone no longer confers SNAP
  // eligibility. The member gate fails, and failed_because names the
  // citizenship/immigration-status check so the answer can cite it.
  it("fails Florida's citizenship/immigration-status check and says which one", async () => {
    const result = await computeProgram({
      program: getProgram("us-fl-snap")!,
      facts: { household_size: 1 },
      members: [{ facts: { member_age: 30, member_is_us_citizen: false, member_is_refugee: true } }],
    });
    const gate = result.member_checks?.find((o) => o.name === "snap_member_eligible");
    expect(gate?.value).toBe("not_holds");
    expect(gate?.failed_because?.map((f) => f.name)).toContain("snap_member_citizenship_or_alien_status_eligible");
    expect(numericOutput(result, "snap_benefit")).toBe(0);
  });
});
