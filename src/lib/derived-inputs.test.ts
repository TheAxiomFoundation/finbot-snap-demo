import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCatalog, getProgram } from "./catalog";
import { CATALOG_OVERLAY } from "./catalog-overlay";
import { describeProgramPayload } from "./describe";
import { runCompiled } from "./engine";
import { buildRequest, computeProgram, deriveInputs, type Facts } from "./request-builder";
import { tools } from "./tools";
import { engineAvailable, numericOutput, output } from "../../scripts/snap-scenarios";

// The real engine, with its calls counted.
vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return { ...actual, runCompiled: vi.fn(actual.runCompiled) };
});

// SNAP Manual 4.1(D) (Vol 73, October 2026) extends categorical eligibility
// to households whose income "falls at or below 130% of the Federal Poverty
// Level". us-sc-snap tests household_gross_income <= 1.3 *
// federal_poverty_level_for_household and takes both as inputs, each 0 by
// default. With the two Family Independence facts set, 0 <= 0 held at any
// income (a 1-person household earning 307% of poverty: eligible, $24), and
// gross income set with the poverty level at 0 failed at any income. Both
// slots now take the program's own outputs: the 100% FPL column of the FY
// income standards, and the composed gross income.
const SC = "us-sc-snap";
const FPL = "federal_poverty_level_for_household";
const GROSS = "household_gross_income";
const FPL_OUTPUT = "snap_net_income_limit_100_percent_fpl_48_states_dc";
const GROSS_OUTPUT = "snap_gross_monthly_income";
const FI_FACTS: Facts = {
  any_member_receives_or_authorized_family_independence_information_referral_services: true,
  household_meets_non_financial_snap_eligibility_criteria: true,
};
const FI_TEST = "household_income_at_or_below_family_independence_fpl_limit";
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

const household = (size: number, facts: Facts) => ({
  program: getProgram(SC)!,
  period: "2026-09",
  facts: { household_size: size, ...facts },
  members: Array.from({ length: size }, (_, i) => ({ facts: { member_is_us_citizen: true, member_age: i === 0 ? 35 : 10 } })),
});

beforeEach(() => {
  vi.mocked(runCompiled).mockClear();
});

describe("derived inputs in the catalog", () => {
  it("marks every overlay entry on its slot, with the rules that read it", () => {
    const declared = Object.entries(CATALOG_OVERLAY).flatMap(([slug, overlay]) =>
      Object.entries(overlay.derived_inputs ?? {}).map(([slot, { output }]) => `${slug}:${slot}<-${output}`)
    );
    const marked = getCatalog().programs.flatMap((p) =>
      Object.values(p.inputs)
        .flat()
        .filter((s) => s.derived_from)
        .map((s) => `${p.slug}:${s.name}<-${s.derived_from}`)
    );
    expect(marked.sort()).toEqual(declared.sort());
    expect(marked.sort()).toEqual([`${SC}:${FPL}<-${FPL_OUTPUT}`, `${SC}:${GROSS}<-${GROSS_OUTPUT}`]);
    const slots = getProgram(SC)!.inputs.Household;
    for (const name of [FPL, GROSS]) {
      const slot = slots.find((s) => s.name === name)!;
      expect(slot.aux).toBeUndefined();
      expect(slot.read_by).toEqual(expect.arrayContaining([FI_TEST, "snap_eligible", "snap_benefit"]));
      expect(slot.read_by).not.toContain(slot.derived_from);
    }
  });

  it("shows the source output in describe_program", () => {
    const slots = describeProgramPayload(getProgram(SC)!).inputs.Household.slots;
    expect(slots).toContain(`${FPL}:decimal(from ${FPL_OUTPUT})`);
    expect(slots).toContain(`${GROSS}:decimal(from ${GROSS_OUTPUT})`);
  });

  it("sets derived values only where the caller left the slot unset", () => {
    const built = buildRequest({ ...household(4, { [GROSS]: 3000 }), derivedInputs: { [FPL]: 2680, [GROSS]: 3400 } });
    expect(built.applied.derived_facts).toEqual({ [FPL]: 2680 });
    expect(built.applied.facts_applied).toMatchObject({ [FPL]: 2680, [GROSS]: 3000 });
    expect(built.applied.notes.filter((n) => n.startsWith(`Set ${FPL}=2680 from ${FPL_OUTPUT}`))).toHaveLength(1);
    expect(built.applied.defaulted_income_slots ?? []).not.toContain(GROSS);
  });
});

describe("deriveInputs engine calls", () => {
  it("makes none for a program without derived inputs or a caller who set them", async () => {
    expect(await deriveInputs({ program: getProgram("us-ny-snap")!, facts: { household_size: 3 } })).toEqual({});
    expect(await deriveInputs(household(4, { [FPL]: 2680, [GROSS]: 3400 }))).toEqual({});
    // A lookup whose output reads neither slot.
    expect(await deriveInputs({ ...household(4, {}), outputsOverride: [FPL_OUTPUT] })).toEqual({});
    expect(runCompiled).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasEngine)("South Carolina categorical eligibility on the real engine", () => {
  it("reads one fast query of both source outputs", async () => {
    const derived = await deriveInputs(household(4, { snap_total_monthly_unearned_income: 3400 }));
    expect(derived).toEqual({ [FPL]: 2680, [GROSS]: 3400 });
    expect(runCompiled).toHaveBeenCalledTimes(1);
    const request = vi.mocked(runCompiled).mock.calls[0][1];
    expect(request.mode).toBe("fast");
    expect(request.queries.flatMap((q) => q.outputs).map((o) => o.split("#").pop()).sort()).toEqual([GROSS_OUTPUT, FPL_OUTPUT].sort());
  });

  it("takes the 100% FPL column for the household's size", async () => {
    // USDA SNAP FY 2026 income eligibility standards, 48 states and DC.
    const expected = [1305, 1763, 2221, 2680, 3138, 3596, 4055, 4513];
    for (const [i, fpl] of expected.entries()) {
      for (const period of ["2026-09", "2026-10"]) {
        expect(await deriveInputs({ ...household(i + 1, {}), period }), `size ${i + 1} ${period}`).toMatchObject({ [FPL]: fpl });
      }
    }
  });

  // Net income above 100% of poverty, gross at or below 130%: only 4.1(D)
  // makes these eligible. PolicyEngine 1.808.0 (September 2026) gives $40.90,
  // $130.70 and $24.00 for the first three and $0 for the last.
  const CASES: Array<[string, number, Facts, string, number]> = [
    ["4 people, $3,400 unearned", 4, { snap_total_monthly_unearned_income: 3400 }, "holds", 40],
    ["6 people, $4,600 unearned", 6, { snap_total_monthly_unearned_income: 4600 }, "holds", 130],
    ["2 people, $2,000 unearned (minimum benefit)", 2, { snap_total_monthly_unearned_income: 2000 }, "holds", 24],
    ["2 people, $3,000 unearned (above 130%)", 2, { snap_total_monthly_unearned_income: 3000 }, "not_holds", 0],
    ["1 person earning 307% of poverty", 1, { snap_gross_monthly_earned_income: 4004 }, "not_holds", 0],
  ];
  for (const [label, size, facts, eligible, benefit] of CASES) {
    it(`applies 4.1(D) with the Family Independence facts set: ${label}`, async () => {
      const result = await computeProgram({ ...household(size, { ...FI_FACTS, ...facts }), extraOutputs: [FI_TEST] });
      expect(output(result, "snap_eligible")).toBe(eligible);
      expect(numericOutput(result, "snap_benefit")).toBe(benefit);
      expect(Object.keys(result.applied.derived_facts ?? {}).sort()).toEqual([FPL, GROSS]);
    });
  }

  it("keeps a value the caller states", async () => {
    // The old defaults: 0 <= 1.3 * 0 holds at 307% of poverty.
    const result = await computeProgram(household(1, { ...FI_FACTS, snap_gross_monthly_earned_income: 4004, [FPL]: 0, [GROSS]: 0 }));
    expect(output(result, "snap_eligible")).toBe("holds");
    expect(numericOutput(result, "snap_benefit")).toBe(24);
    expect(result.applied.derived_facts).toBeUndefined();
  });

  it("derives in lookup_value when the output reads the slot", async () => {
    const context = { toolCallId: "derived-inputs", messages: [] };
    const lookup = (output: string, facts: Facts) =>
      tools.lookup_value.execute!({ program: SC, output, period: "2026-09", facts: { household_size: 4, ...facts } }, context) as Promise<any>;
    const test = await lookup(FI_TEST, { snap_total_monthly_unearned_income: 4000 });
    expect(test.value).toBe("not_holds");
    expect(test.applied.derived_facts).toEqual({ [FPL]: 2680, [GROSS]: 4000 });
    expect((await lookup(FI_TEST, { snap_total_monthly_unearned_income: 3400 })).value).toBe("holds");
    const limit = await lookup(FPL_OUTPUT, {});
    expect(limit.value).toBe(2680);
    expect(limit.applied.derived_facts).toBeUndefined();
  });
});
