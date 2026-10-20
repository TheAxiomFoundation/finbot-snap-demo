import { describe, expect, it } from "vitest";

import { allowanceSlots, allowanceWarning } from "./added-allowances";
import { getCatalog, getProgram } from "./catalog";
import { describeProgramPayload } from "./describe";
import { checkGrounding } from "./grounding";
import type { DerivedTraceNode, ExecutionResponse, OutputValue } from "./engine";
import { buildSystemPrompt } from "./prompts";
import { buildRequest, computeProgram, queryKey, shapeResult, type BuildOptions, type Facts } from "./request-builder";
import { engineAvailable, numericOutput } from "../../scripts/snap-scenarios";

// eval az-snap-elderly: "I'm 67, live alone in Arizona on $1,200 a month of
// Social Security. My rent is $900 and my utility allowance is $323." Every
// gpt-6-luna run sent household_shelter_costs_incurred = 1223 ($900 + $323).
// us-az-snap shelter_costs adds az_applied_utility_allowance ($323, from four
// utility facts that default to true) on top of that slot, so the utilities
// counted twice and the uncapped elderly shelter deduction zeroed net income:
// $298 (the maximum) instead of $219.
const az = getProgram("us-az-snap")!;
const SHELTER = "household_shelter_costs_incurred";
const AZ_ALLOWANCE = "az_applied_utility_allowance";
const HEATING_OR_COOLING =
  "budgetary_unit_obligated_to_pay_heating_or_cooling_expense_separately_from_rent_or_mortgage_on_regular_basis";
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

const recordedCall = (shelter: number | undefined, extra: Facts = {}): BuildOptions => ({
  program: az,
  facts: {
    household_size: 1,
    snap_total_monthly_unearned_income: 1200,
    ...(shelter === undefined ? {} : { [SHELTER]: shelter }),
    budgetary_unit_has_participant_who_is_elderly_or_has_disability: true,
    ...extra,
  },
  members: [{ facts: { snap_member_is_elderly_or_disabled: true } }],
  extraOutputs: ["snap_total_allowable_shelter_expenses"],
});
const allowanceNotes = (notes: string[]) => notes.filter((n) => n.includes(`on top of ${SHELTER}=`));

describe("allowances added to a cost slot, in the catalog", () => {
  const annotated = getCatalog().programs.flatMap((p) => allowanceSlots(p).map((s) => `${p.slug}:${s.name}`));

  it("marks the shelter slot where the rules add a utility allowance to it", () => {
    expect(annotated.sort()).toEqual([
      "us-az-snap:household_shelter_costs_incurred",
      "us-ca-snap:household_shelter_costs_incurred",
      "us-co-snap:household_shelter_costs_incurred",
      "us-ma-snap:household_shelter_costs_incurred",
      "us-ny-snap:household_shelter_costs_incurred",
    ]);
    const [slot] = allowanceSlots(az);
    expect(slot.added_allowances.map((a) => a.rule)).toEqual([AZ_ALLOWANCE]);
    expect(slot.added_allowances[0].flags).toContain(HEATING_OR_COOLING);
  });

  it("leaves programs whose shelter sum is the slot alone, and other sums, unmarked", () => {
    // us-fl-snap snap_total_allowable_shelter_expenses = household_shelter_costs_incurred.
    for (const slug of ["us-al-snap", "us-fl-snap", "us-ga-snap", "us-nc-snap", "us-sc-snap", "us-tn-snap"]) {
      expect(allowanceSlots(getProgram(slug)!)).toEqual([]);
    }
    // us-fiit amt_income adds the senior deduction back to taxable_income;
    // that is no allowance standing in for costs the slot must leave out.
    expect(allowanceSlots(getProgram("us-fiit")!)).toEqual([]);
  });
});

describe("describe_program", () => {
  it("annotates the slot and says the slot takes rent without utilities", () => {
    const payload = describeProgramPayload(az);
    expect(payload.inputs.Household.slots).toContain(`${SHELTER}:integer(+${AZ_ALLOWANCE})`);
    const note = payload.notes.find((n) => n.startsWith(`${SHELTER} (+`))!;
    expect(note).toContain("rent or mortgage, property tax and insurance");
    expect(note).toContain("never a utility bill or a utility allowance the user states");
    // The defaults already claim the allowance in Arizona.
    expect(note).toContain(`true by default: `);
    expect(note).toContain(HEATING_OR_COOLING);
    expect(payload.slot_legend).toContain("(+name)");
  });

  it("names a flag to set where none claims the allowance by default", () => {
    const note = describeProgramPayload(getProgram("us-ca-snap")!).notes.find((n) => n.startsWith(`${SHELTER} (+`))!;
    expect(note).toContain("all false by default");
    expect(note).toContain("household_has_heating_and_cooling_costs_separate_from_rent_or_mortgage");
  });

  it("adds nothing for a program without an added allowance", () => {
    const payload = describeProgramPayload(getProgram("us-fl-snap")!);
    expect(Object.values(payload.inputs).flatMap((e) => e.slots)).toContain(`${SHELTER}:decimal`);
    expect(payload.notes.some((n) => n.includes("(+"))).toBe(false);
  });

  it("the system prompt reads the annotation and the warning", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("`(+X)` after a cost slot");
    expect(prompt).toContain("Allowance warnings");
  });
});

describe("allowance warning in the applied report", () => {
  // shapeResult reads the allowance from the trace; a synthetic response
  // pins the cases without the engine.
  const synthetic = (options: BuildOptions, allowance: number | null) => {
    const built = buildRequest(options);
    const outputs: Record<string, OutputValue> = {};
    for (const o of built.queried) {
      if (built.memberCheckNames.has(o.name)) continue;
      const key = queryKey(o);
      outputs[key] =
        o.semantics === "judgment"
          ? { kind: "judgment", name: o.name, id: key, outcome: "holds" }
          : { kind: "scalar", name: o.name, id: key, dtype: "decimal", value: { kind: "decimal", value: "219" } };
    }
    const allowanceOutput = az.outputs.find((o) => o.name === AZ_ALLOWANCE)!;
    const trace: Record<string, DerivedTraceNode> =
      allowance === null
        ? {}
        : {
            [queryKey(allowanceOutput)]: {
              kind: "scalar",
              name: AZ_ALLOWANCE,
              id: queryKey(allowanceOutput),
              value: { kind: "decimal", value: String(allowance) },
              dependencies: [],
            },
          };
    const response: ExecutionResponse = {
      metadata: { requested_mode: "explain", actual_mode: "explain", fallback_reason: null },
      results: [{ entity_id: "household:1", period: { period_kind: "month", start: "2026-10-01", end: "2026-10-31" }, outputs, trace }],
    };
    return shapeResult(az, built, response);
  };

  it("names the added allowance, the stated figure and the defaults behind it", () => {
    const result = synthetic(recordedCall(1223), 323);
    expect(result.applied.added_allowances).toEqual([
      {
        slot: SHELTER,
        stated: 1223,
        added: [{ rule: AZ_ALLOWANCE, amount: 323 }],
        defaults_read: expect.arrayContaining([HEATING_OR_COOLING]),
      },
    ]);
    const [note] = allowanceNotes(result.applied.notes);
    expect(note).toMatch(/^WARNING: the rules added az_applied_utility_allowance=323 on top of household_shelter_costs_incurred=1223/);
    expect(note).toContain(`${HEATING_OR_COOLING}=true`);
    expect(note).toContain("already includes a utility bill or a utility allowance, it counts twice");
    expect(note).toContain("If 1223 is only those costs, keep this result.");
  });

  it("leaves out a flag the caller set", () => {
    const [note] = allowanceNotes(synthetic(recordedCall(900, { [HEATING_OR_COOLING]: true }), 323).applied.notes);
    expect(note).toContain("household_shelter_costs_incurred=900");
    expect(note).not.toContain(HEATING_OR_COOLING);
  });

  it("stays silent when the slot is unset or no allowance was added", () => {
    expect(synthetic(recordedCall(undefined), 323).applied.added_allowances).toBeUndefined();
    expect(allowanceNotes(synthetic(recordedCall(undefined), 323).applied.notes)).toEqual([]);
    expect(allowanceNotes(synthetic(recordedCall(1223), 0).applied.notes)).toEqual([]);
    expect(allowanceNotes(synthetic(recordedCall(1223), null).applied.notes)).toEqual([]);
  });

  it("words a non-utility allowance without the utility advice", () => {
    const slot = { name: "x_costs", dtype: "decimal" as const, default: 0, added_allowances: [{ rule: "x_allowance", flags: [] }] };
    const note = allowanceWarning(slot, 50, [{ rule: "x_allowance", amount: 10 }], []);
    expect(note).toContain("the costs that allowance stands in for");
    expect(note).not.toContain("utility");
  });
});

describe.skipIf(!hasEngine)("real-engine Arizona shelter costs with a stated utility allowance", () => {
  it("the recorded call counts the $323 twice and reaches the maximum", async () => {
    const result = await computeProgram(recordedCall(1223));
    expect(numericOutput(result, "snap_benefit")).toBe(298);
    // 1,223 + the 323 the rules add again.
    expect(numericOutput(result, "snap_total_allowable_shelter_expenses")).toBe(1546);
    const [note] = allowanceNotes(result.applied.notes);
    expect(note).toContain(`${AZ_ALLOWANCE}=323 on top of ${SHELTER}=1223`);
  });

  it("rent alone gets the allowance once: about $219.10 (the PolicyEngine oracle)", async () => {
    const result = await computeProgram(recordedCall(900));
    const benefit = numericOutput(result, "snap_benefit");
    expect(Math.abs(benefit - 219.1)).toBeLessThanOrEqual(1.5);
    expect(benefit).toBe(219);
    expect(numericOutput(result, "snap_total_allowable_shelter_expenses")).toBe(1223);
    // Still disclosed, with the advice to keep a rent-only figure.
    expect(allowanceNotes(result.applied.notes)[0]).toContain("If 900 is only those costs, keep this result.");
  });

  it("a reply that states the allowance amount is grounded in the result (us-ny-snap)", async () => {
    // The first live run named the warning's amount in Assumptions ("added a
    // $1,062 standard heating/utility allowance"), but it sat only inside the
    // note's text, which the grounding check doesn't read: ny-snap-family3,
    // ca-snap-family4 and ma-snap-parent-1kid failed `grounded`.
    const prompt =
      "I'm a single parent in New York with two kids (8 and 5). I earn $2,078 a month, my rent is $1,300, and I pay heating separately from rent. What SNAP would we get?";
    const { provenance, stamps, ...result } = await computeProgram({
      program: getProgram("us-ny-snap")!,
      facts: {
        household_size: 3,
        snap_gross_monthly_earned_income: 2078,
        [SHELTER]: 1300,
        household_incurred_or_anticipated_heating_or_cooling_costs_separate_from_rent_or_mortgage: true,
      },
    });
    void provenance;
    void stamps;
    const [entry] = result.applied.added_allowances!;
    const amount = entry.added.reduce((sum, a) => sum + a.amount, 0);
    expect(entry.slot).toBe(SHELTER);
    expect(amount).toBeGreaterThan(0);
    const reply = `I treated $1,300 as rent only; the rules added a $${amount.toLocaleString("en-US")} standard utility allowance, for $${(1300 + amount).toLocaleString("en-US")} in shelter costs.`;
    expect(checkGrounding(reply, [result], prompt).invented).toEqual([]);
  });

  it("no warning where the shelter sum has no allowance (us-fl-snap)", async () => {
    const result = await computeProgram({
      program: getProgram("us-fl-snap")!,
      facts: { household_size: 1, snap_total_monthly_unearned_income: 1200, [SHELTER]: 900 },
    });
    expect(allowanceNotes(result.applied.notes)).toEqual([]);
  });
});
