import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getProgram } from "./catalog";
import { CATALOG_OVERLAY } from "./catalog-overlay";
import { runCompiled } from "./engine";
import { buildRequest, NotSettableInputError } from "./request-builder";
import { tools } from "./tools";

vi.mock("./engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./engine")>()),
  runCompiled: vi.fn(),
}));

const blocked = [
  ["us-ma-snap", "snap_household_is_categorically_eligible", "Massachusetts"],
  ["us-al-snap", "household_is_categorically_eligible", "Alabama"],
  ["us-tn-snap", "household_is_categorically_eligible", "Tennessee"],
  ["us-az-snap", "na_budgetary_unit_is_eligible", "Arizona"],
] as const;

beforeEach(() => vi.clearAllMocks());

describe("BBCE input plumbing", () => {
  it("defaults California's administrative pamphlet fact and discloses its provenance", () => {
    const program = getProgram("us-ca-snap")!;
    const slot = program.inputs.Household.find((s) => s.name === "household_was_issued_pub_275")!;
    expect(CATALOG_OVERLAY[program.slug].default_overrides?.household_was_issued_pub_275).toBe(true);
    expect(slot).toMatchObject({ default: true, default_source: "overlay" });
    const built = buildRequest({ program, period: "2026-09", facts: { household_size: 3 } });
    expect(built.applied.overlay_defaults_in_effect?.household_was_issued_pub_275).toBe(true);
    const overridden = buildRequest({ program, period: "2026-09", facts: { household_was_issued_pub_275: false } });
    expect(overridden.applied.overlay_defaults_in_effect?.household_was_issued_pub_275).toBeUndefined();
    expect(overridden.request.dataset.inputs.filter((i) => i.name.endsWith("input.household_was_issued_pub_275"))
      .every((i) => i.value.value === false)).toBe(true);
  });

  it("withholds Colorado's unsafe BBCE default", () => {
    const program = getProgram("us-co-snap")!;
    expect(CATALOG_OVERLAY[program.slug].default_overrides?.snap_expanded_categorical_eligible).toBeUndefined();
    expect(program.inputs.Household.find((s) => s.name === "snap_expanded_categorical_eligible")?.default).toBe(false);
    expect(() => buildRequest({ program, facts: { snap_expanded_categorical_eligible: true } }))
      .toThrow("Colorado SNAP encoding does not yet apply categorical eligibility exclusions");
  });

  it("derives New York's earned-income companion only from its factual income slot", () => {
    fc.assert(fc.property(fc.integer({ min: -1000, max: 100000 }), fc.boolean(), (earned, contradictoryFlag) => {
      const built = buildRequest({
        program: getProgram("us-ny-snap")!, period: "2026-09",
        facts: { snap_gross_monthly_earned_income: earned, household_has_earned_income_budgeted_for_snap: contradictoryFlag },
      });
      const expected = earned > 0;
      expect(built.applied.derived_facts).toEqual({ household_has_earned_income_budgeted_for_snap: expected });
      expect(built.applied.facts_applied.household_has_earned_income_budgeted_for_snap).toBe(expected);
      expect(built.request.dataset.inputs.filter((i) => i.name.endsWith("input.household_has_earned_income_budgeted_for_snap"))
        .every((i) => i.value.value === expected)).toBe(true);
      expect(built.applied.notes.filter((n) => n.startsWith("Derived household_has_earned_income_budgeted_for_snap")))
        .toHaveLength(1);
    }));
    expect(buildRequest({ program: getProgram("us-ny-snap")! }).applied.derived_facts)
      .toEqual({ household_has_earned_income_budgeted_for_snap: false });
  });

  it("includes each relevant limitation once per request and only on its program", () => {
    for (const state of ["az", "ma", "fl", "al", "tn", "co"]) {
      const program = getProgram(`us-${state}-snap`)!;
      const built = buildRequest({ program });
      for (const note of CATALOG_OVERLAY[program.slug].notes!) {
        expect(built.applied.notes.filter((n) => n === note)).toHaveLength(1);
      }
      expect(built.applied.notes.filter((n) => n.startsWith("SNAP figures use FY2026"))).toHaveLength(1);
    }
    expect(buildRequest({ program: getProgram("us-fiit")! }).applied.notes.some((n) => n.includes("FY2026"))).toBe(false);
  });
});

describe("assistant eligibility-gate guards", () => {
  it("rejects every supplied value through household and member facts", () => {
    fc.assert(fc.property(fc.constantFrom(...blocked), fc.oneof(fc.boolean(), fc.integer(), fc.string()), (entry, value) => {
      const [slug, slot, state] = entry;
      const program = getProgram(slug)!;
      for (const membersPath of [false, true]) {
        const options = membersPath ? { members: [{ facts: {} }, { facts: { [slot]: value } }] } : { facts: { [slot]: value } };
        try {
          buildRequest({ program, ...options });
          throw new Error("guard did not reject the input");
        } catch (err) {
          expect(err).toBeInstanceOf(NotSettableInputError);
          expect(err).toMatchObject({
            kind: "not_settable_input", slot,
            path: membersPath ? `members[1].facts.${slot}` : `facts.${slot}`,
            message: `not settable by the assistant: Axiom's ${state} SNAP encoding does not yet determine categorical eligibility from income`,
          });
        }
      }
    }));
  });

  it("returns structured errors from compute and lookup without executing the engine", async () => {
    for (const [slug, slot] of blocked) {
      for (const membersPath of [false, true]) {
        const supplied = membersPath ? { members: [{ facts: { [slot]: false } }] } : { facts: { [slot]: true } };
        const context = { toolCallId: "guard-test", messages: [] };
        const compute = await tools.compute.execute!({ program: slug, ...supplied }, context);
        const lookup = await tools.lookup_value.execute!({ program: slug, output: getProgram(slug)!.primary_output, ...supplied }, context);
        for (const result of [compute, lookup]) {
          expect(result).toMatchObject({ kind: "not_settable_input", slot, path: membersPath ? `members[0].facts.${slot}` : `facts.${slot}` });
        }
      }
    }
    expect(runCompiled).not.toHaveBeenCalled();
  });

  it("does not allow Colorado's basic categorical sibling as a BBCE workaround", async () => {
    const program = getProgram("us-co-snap")!;
    for (const slot of ["snap_expanded_categorical_eligible", "snap_basic_categorical_eligible"]) {
      for (const value of [false, true]) {
        for (const membersPath of [false, true]) {
          const supplied = membersPath ? { members: [{ facts: { [slot]: value } }] } : { facts: { [slot]: value } };
          const context = { toolCallId: "colorado-guard-test", messages: [] };
          for (const result of [
            await tools.compute.execute!({ program: program.slug, ...supplied }, context),
            await tools.lookup_value.execute!({ program: program.slug, output: program.primary_output, ...supplied }, context),
          ]) {
            expect(result).toMatchObject({
              error: "not settable by the assistant: Axiom's Colorado SNAP encoding does not yet apply categorical eligibility exclusions",
              kind: "not_settable_input", slot,
              path: membersPath ? `members[0].facts.${slot}` : `facts.${slot}`,
            });
          }
        }
      }
    }
    expect(runCompiled).not.toHaveBeenCalled();
  });
});
