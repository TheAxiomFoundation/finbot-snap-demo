import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCompiled } from "./engine";
import { tools } from "./tools";

vi.mock("./engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./engine")>()),
  runCompiled: vi.fn(),
}));

const program = "us-ny-snap";
const output = "snap_member_citizenship_or_alien_status_eligible";
const context = { toolCallId: "formula-coverage-tools-test", messages: [] };
beforeEach(() => vi.clearAllMocks());

describe("formula coverage at the tool boundary", () => {
  it("returns the same honest disclosure from compute and lookup for either engine transport", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2000, max: 2030 }),
      fc.integer({ min: 1, max: 12 }),
      fc.boolean(),
      fc.constantFrom("axiom-rules-engine exited 1: ", 'axiom-engine 500: {"detail":"axiom-rules-engine exited 1: '),
      async (year, month, annual, prefix) => {
        const period = annual ? String(year) : `${year}-${String(month).padStart(2, "0")}`;
        const date = `${year}-${String(annual ? 1 : month).padStart(2, "0")}-01`;
        const suffix = prefix.includes("detail") ? '"}' : "";
        vi.mocked(runCompiled).mockRejectedValue(new Error(`${prefix}derived \`${output}\` has no formula version at ${date}${suffix}`));
        for (const result of [
          await tools.compute.execute!({ program, period }, context),
          await tools.lookup_value.execute!({ program, period, output }, context),
        ]) {
          const disclosure = `Axiom has no rule in force for ${period} for ${output}.`;
          expect(result).toMatchObject({ kind: "no_formula_version", program, period, output, at_date: date, error: disclosure });
          expect(result).toHaveProperty("applied.disclosures", expect.arrayContaining([disclosure]));
          expect(result).not.toHaveProperty("outputs");
          expect(result).not.toHaveProperty("value");
          expect(result).not.toHaveProperty("primary_output");
        }
      }
    ), { numRuns: 24, seed: 1612 });
  });

  it("preserves unrelated failures", async () => {
    const error = new Error("engine connection failed");
    vi.mocked(runCompiled).mockRejectedValue(error);
    await expect(tools.lookup_value.execute!({ program, period: "2025-07", output }, context)).rejects.toBe(error);
    await expect(tools.compute.execute!({ program, period: "2025-07" }, context)).rejects.toBe(error);
  });
});
