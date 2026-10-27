import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import { buildRequest, computeProgram } from "./request-builder";
import { engineAvailable, numericOutput } from "../../scripts/snap-scenarios";

// lookup_value reads one output (outputsOverride). Every us-fiit lookup
// listed the senior-SSN assumption, and in 6 of 20 live gpt-6-luna runs of
// "What is the personal exemption amount for 2026?" the answer added an
// Assumptions line about an SSN that "does not affect this exemption
// amount". A lookup now discloses an assumption only when the catalog's
// read_by for the slot names the output.
const SSN = "qualified_individual_social_security_number_included_on_return";
const fiit = getProgram("us-fiit")!;
const flSnap = getProgram("us-fl-snap")!;
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

const lookup = (program: typeof fiit, output: string, facts = {}) =>
  buildRequest({ program, period: "2026", facts, outputsOverride: [output] });

describe("assumed facts on the lookup path", () => {
  it("lists the outputs that read the SSN slot in the catalog", () => {
    const slot = fiit.inputs.Person.find((s) => s.name === SSN)!;
    expect(slot.read_by).toContain("senior_deduction");
    expect(slot.read_by).not.toContain("exemption_amount");
  });

  it("leaves the SSN assumption out of an exemption_amount lookup", () => {
    expect(lookup(fiit, "exemption_amount").applied.assumed_facts).toBeUndefined();
  });

  it("keeps the SSN assumption on a senior_deduction lookup", () => {
    expect(lookup(fiit, "senior_deduction").applied.assumed_facts).toEqual([
      expect.objectContaining({ slot: SSN, value: true, members: [1] }),
    ]);
  });

  it("keeps it when an extra output reads the slot", () => {
    const built = buildRequest({
      program: fiit,
      period: "2026",
      facts: {},
      outputsOverride: ["exemption_amount"],
      extraOutputs: ["senior_deduction"],
    });
    expect(built.applied.assumed_facts?.map((a) => a.slot)).toEqual([SSN]);
  });

  it("applies to the SNAP citizenship assumption too", () => {
    const facts = { household_size: 3 };
    expect(lookup(flSnap, "snap_gross_income_limit_130_percent_fpl_48_states_dc", facts).applied.assumed_facts).toBeUndefined();
    expect(lookup(flSnap, "snap_regular_month_allotment", facts).applied.assumed_facts?.map((a) => a.slot)).toEqual([
      "member_is_us_citizen",
    ]);
  });

  it("leaves computes unchanged", () => {
    const built = buildRequest({ program: fiit, period: "2026", facts: {} });
    expect(built.applied.assumed_facts?.map((a) => a.slot)).toEqual([
      SSN,
      "qualifying_child_name_age_and_tin_included_on_return",
    ]);
  });
});

describe.skipIf(!hasEngine)("real-engine exemption_amount lookup", () => {
  it("returns $0 for 2026 with no SSN assumption", async () => {
    const result = await computeProgram({ program: fiit, period: "2026", facts: {}, outputsOverride: ["exemption_amount"] });
    expect(numericOutput(result, "exemption_amount")).toBe(0);
    expect(result.applied.assumed_facts).toBeUndefined();
  }, 30_000);

  it("still discloses it on a senior_deduction lookup for a 70-year-old", async () => {
    const result = await computeProgram({
      program: fiit,
      period: "2026",
      facts: { adjusted_gross_income: 100000, taxpayer_married_at_close_of_taxable_year: false },
      members: [{ facts: { age: 70, individual_age_at_close_of_calendar_year: 70, is_taxpayer: true } }],
      outputsOverride: ["senior_deduction"],
    });
    expect(numericOutput(result, "senior_deduction")).toBe(4500);
    expect(result.applied.assumed_facts).toEqual([expect.objectContaining({ slot: SSN, members: [1] })]);
  }, 30_000);
});
