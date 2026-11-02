import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError, runCompiled, type ExecutionResponse } from "./engine";
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
        vi.mocked(runCompiled).mockRejectedValue(new EngineError(`${prefix}derived \`${output}\` has no formula version at ${date}${suffix}`));
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

  it("keeps unrelated failures distinct from formula gaps", async () => {
    // Returned, not rethrown: a throw inside a tool executor ends the chat
    // stream with an empty reply.
    vi.mocked(runCompiled).mockRejectedValue(new Error("engine connection failed"));
    for (const result of [
      await tools.lookup_value.execute!({ program, period: "2025-07", output }, context),
      await tools.compute.execute!({ program, period: "2025-07" }, context),
    ]) {
      expect(result).toMatchObject({ error: "calculation failed: engine connection failed", hint: expect.any(String) });
      expect(result).not.toHaveProperty("kind");
      expect(result).not.toHaveProperty("outputs");
      expect(result).not.toHaveProperty("value");
    }
  });

  // A malformed name is quoted in the builder's typed refusal. It must come
  // back as that refusal, never as a missing-formula disclosure.
  it("reports a malformed name that quotes the engine diagnostic as the builder's refusal", async () => {
    const malformed = "derived `snap_regular_month_allotment` has no formula version at 2025-07-01";
    const results = [
      [await tools.lookup_value.execute!({ program, period: "2025-07", output: malformed }, context), "unknown output"],
      [await tools.compute.execute!({ program, period: "2025-07", facts: { [malformed]: 1 } }, context), "unknown input"],
      [await tools.lookup_value.execute!({ program, period: "2025-07", output, facts: { [malformed]: 1 } }, context), "unknown input"],
      [await tools.compute.execute!({ program, period: "2025-07", members: [{ relations: [malformed] }] }, context), "unknown relation"],
    ] as const;
    for (const [result, refusal] of results) {
      expect(result).not.toHaveProperty("kind", "no_formula_version");
      expect(result).not.toHaveProperty("applied");
      expect((result as { error: string }).error).toContain(refusal);
      expect((result as { error: string }).error).toContain(malformed);
    }
    expect(runCompiled).not.toHaveBeenCalled();
  });

  it("reads the diagnostic only from an error the engine reported", async () => {
    // The same text in an untagged error (not from either engine transport)
    // stays a plain calculation failure.
    vi.mocked(runCompiled).mockRejectedValue(new Error(`derived \`${output}\` has no formula version at 2025-07-01`));
    for (const result of [
      await tools.lookup_value.execute!({ program, period: "2025-07", output }, context),
      await tools.compute.execute!({ program, period: "2025-07" }, context),
    ]) {
      expect(result).toMatchObject({ error: expect.stringMatching(/^calculation failed: /), hint: expect.any(String) });
      expect(result).not.toHaveProperty("kind");
    }
  });

  it("names no applied law for a value the engine did not return", async () => {
    // A malformed engine answer: no result, or a result without the output.
    for (const results of [[], [{ entity_id: "person:1", outputs: {} }]]) {
      vi.mocked(runCompiled).mockResolvedValue({ results } as unknown as ExecutionResponse);
      const result = (await tools.lookup_value.execute!({ program, period: "2026-10", output }, context)) as Record<string, unknown>;
      expect(result.value).toBeNull();
      expect(result).not.toHaveProperty("amended_by");
    }
  });
});
