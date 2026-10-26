import { describe, expect, it } from "vitest";
import { BBCE_STARTERS, STARTERS } from "../src/lib/starters";
import { getProgram } from "../src/lib/catalog";
import { computeProgram } from "../src/lib/request-builder";
import { engineAvailable, memberCheck, numericOutput, output, starterScenario, STARTER_FIXTURES } from "./snap-scenarios";
import { SCENARIOS } from "../eval/preset-compare";

describe("BBCE starter candidates", () => {
  it("features one TANF, one federal tax and one SNAP starter", () => {
    expect(STARTERS.filter((s) => s.includes("TANF"))).toHaveLength(1);
    expect(STARTERS.some((s) => s.includes("EITC"))).toBe(true);
    expect(STARTERS.some((s) => s.includes("SNAP"))).toBe(true);
    expect(STARTERS.some((s) => s.includes("New York"))).toBe(false);
  });

  it("keeps every featured starter in the compare-mode eval", () => {
    const questions = new Set(SCENARIOS.map((s) => s.question));
    for (const starter of STARTERS) expect(questions).toContain(starter);
  });

  it("answers the Utah TANF starter from an output with no not-fully-encoded flag", () => {
    // The engine's $662 for a household of three is pinned by the oracle
    // case ut-tanf-family3. Utah's eligibility outputs stay flagged.
    const utah = getProgram("us-ut-tanf")!;
    expect(utah.primary_output).toBe("ut_fep_payment_standard_amount");
    expect(utah.acknowledged_incomplete).not.toContain(utah.primary_output);
    expect(utah.outputs.find((o) => o.name === utah.primary_output)?.acknowledged_incomplete).toBe(false);
    expect(utah.acknowledged_incomplete).toContain("ut_fep_eligible");
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
    const gate = memberCheck(result, 1, "snap_member_eligible");
    expect(gate.value).toBe("not_holds");
    expect(gate.failed_because?.map((f) => f.name)).toContain("snap_member_citizenship_or_alien_status_eligible");
    expect(numericOutput(result, "snap_benefit")).toBe(0);
    // A stated status is never overridden by the citizenship assumption.
    expect(result.applied.assumed_facts).toBeUndefined();
  });
});

describe.skipIf(!engineAvailable())("assumed SNAP citizenship", () => {
  const program = () => getProgram("us-fl-snap")!;
  const household = { household_size: 3, snap_gross_monthly_earned_income: 1800, household_shelter_costs_incurred: 1100 };

  it("assumes U.S. citizenship for members with no stated status, and discloses it", async () => {
    const result = await computeProgram({
      program: program(),
      facts: household,
      members: [{ facts: { member_age: 30 } }, { facts: { member_age: 8 } }, { facts: { member_age: 5 } }],
    });
    expect(result.applied.assumed_facts).toEqual([
      expect.objectContaining({ slot: "member_is_us_citizen", value: true, members: [1, 2, 3] }),
    ]);
    expect(output(result, "snap_eligible")).toBe("holds");
    expect(numericOutput(result, "snap_benefit")).toBeGreaterThan(0);
  });

  it("assumes it for synthesized members too", async () => {
    const result = await computeProgram({ program: program(), facts: household });
    expect(result.applied.assumed_facts?.[0]?.members.length).toBeGreaterThan(0);
    expect(output(result, "snap_eligible")).toBe("holds");
  });

  it("does not assume it for a member whose status is stated", async () => {
    const result = await computeProgram({
      program: program(),
      facts: household,
      members: [{ facts: { member_age: 30, member_is_us_citizen: false, member_is_asylee: true } }, { facts: { member_age: 8 } }],
    });
    expect(result.applied.assumed_facts?.[0]?.members).toEqual([2]);
  });

  it("assumes nothing when a top-level fact states immigration status", async () => {
    const result = await computeProgram({
      program: program(),
      facts: { ...household, member_is_refugee: true },
    });
    expect(result.applied.assumed_facts).toBeUndefined();
  });
});
