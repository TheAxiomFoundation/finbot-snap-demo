import { afterEach, describe, expect, it, vi } from "vitest";

import { getProgram } from "./catalog";
import * as engine from "./engine";
import { computeProgram, type MemberSpec } from "./request-builder";
import { engineAvailable, numericOutput } from "../../scripts/snap-scenarios";

// A lookup with a members list runs a second time with the member gates its
// value counts through. That run must never fail or change the lookup: the
// first version queried every gate in the lookup's own request, and a SNAP
// gate with no parameter value at 2025-06 failed the whole engine run
// (CI, test:regression). Here the second run fails, or comes back with a
// different value, and the plain lookup stands.
vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return { ...actual, runCompiled: vi.fn(actual.runCompiled) };
});

const fiit = getProgram("us-fiit")!;
const child: MemberSpec = {
  facts: {
    age: 10,
    individual_age_at_close_of_calendar_year: 10,
    individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
    individual_is_younger_than_taxpayer: true,
    individual_principal_place_of_abode_with_taxpayer_fraction: 1,
    qualifying_child_principal_place_of_abode_is_in_united_states: true,
  },
};
const LOOKUP = {
  program: fiit,
  period: "2026",
  members: [{ facts: { is_taxpayer: true, age: 40 } }, child, child] as MemberSpec[],
  outputsOverride: ["eitc_maximum"],
};
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}
const runCompiled = vi.mocked(engine.runCompiled);

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!hasEngine)("lookup member checks run apart from the lookup", () => {
  it("adds member_checks on a second run", async () => {
    runCompiled.mockClear();
    const result = await computeProgram(LOOKUP);
    expect(runCompiled).toHaveBeenCalledTimes(2);
    expect(numericOutput(result, "eitc_maximum")).toBe(7316);
    expect(result.member_checks?.length).toBe(3);
  }, 30_000);

  it("keeps the plain lookup when the second run fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runCompiled.mockClear();
    const actual = runCompiled.getMockImplementation()!;
    runCompiled
      .mockImplementationOnce(actual)
      .mockRejectedValueOnce(new Error("parameter `x` has no value for key `0` at 2025-06-01"));
    const result = await computeProgram(LOOKUP);
    expect(numericOutput(result, "eitc_maximum")).toBe(7316);
    expect(result.member_checks).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("lookup member checks failed"), expect.anything(), "program:", "us-fiit");
  }, 30_000);

  it("keeps the plain lookup when the second run gives a different value", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runCompiled.mockClear();
    const actual = runCompiled.getMockImplementation()!;
    runCompiled.mockImplementationOnce(actual).mockImplementationOnce(async (slug, request) => {
      const response = await actual(slug, request);
      for (const result of response.results) {
        for (const [key, value] of Object.entries(result.outputs ?? {})) {
          if (key.endsWith("#eitc_maximum") && value.kind === "scalar") value.value = { kind: "integer", value: 1 };
        }
      }
      return response;
    });
    const result = await computeProgram(LOOKUP);
    expect(numericOutput(result, "eitc_maximum")).toBe(7316);
    expect(result.member_checks).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("changed the outputs"), "us-fiit", expect.any(String), expect.any(String));
  }, 30_000);

  it("runs once when the value counts members through no gate", async () => {
    runCompiled.mockClear();
    const result = await computeProgram({ ...LOOKUP, outputsOverride: ["exemption_amount"] });
    expect(runCompiled).toHaveBeenCalledTimes(1);
    expect(result.member_checks).toBeUndefined();
  }, 30_000);
});
