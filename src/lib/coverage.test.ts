import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { getCatalog } from "./catalog";
import { coverageSentence, summarizeCoverage } from "./coverage";

const program = fc.record({
  slug: fc.string({ minLength: 1, maxLength: 12 }),
  jurisdiction: fc.oneof(
    fc.constant("us"),
    fc.stringMatching(/^us-[a-z]{2}$/),
    fc.string({ maxLength: 8 })
  ),
  program_id: fc.oneof(
    fc.constantFrom("snap", "tanf", "tca", "fiit", "income-tax", "scretd", "oasdi-wage-tax"),
    fc.string({ maxLength: 10 })
  ),
  primary_output: fc.constantFrom("a", "b", "c"),
  acknowledged_incomplete: fc.subarray(["a", "b", "c"]),
});

describe("summarizeCoverage invariants", () => {
  it("partitions every program into exactly one group", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
        const summary = summarizeCoverage(programs);
        expect(summary.total).toBe(programs.length);
        expect(summary.groups.reduce((n, g) => n + g.count, 0)).toBe(programs.length);
        expect(summary.groups.every((g) => g.count > 0)).toBe(true);
        expect(new Set(summary.groups.map((g) => g.key)).size).toBe(summary.groups.length);
      })
    );
  });

  it("counts incomplete programs by their headline output, bounded by the total", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
        const summary = summarizeCoverage(programs);
        const expected = programs.filter((p) => p.acknowledged_incomplete.includes(p.primary_output)).length;
        expect(summary.incomplete).toBe(expected);
        expect(summary.incomplete).toBeLessThanOrEqual(summary.total);
      })
    );
  });

  it("only claims a state count for state-level programs", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
        for (const group of summarizeCoverage(programs).groups) {
          if (group.key === "snap" || group.key === "cash" || group.key === "state-income-tax") {
            expect(group.members.every((m) => /^[A-Z]{2}$/.test(m))).toBe(true);
          }
        }
      })
    );
  });

  it("names every nonempty group in the sentence", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
        const summary = summarizeCoverage(programs);
        const sentence = coverageSentence(summary);
        for (const g of summary.groups) expect(sentence).toContain(g.phrase);
        if (programs.length === 0) expect(sentence).toBe("");
      })
    );
  });
});

describe("summarizeCoverage on the pinned catalog", () => {
  const catalog = getCatalog();
  const summary = summarizeCoverage(catalog.programs, (p) => p.display_name);

  it("covers the whole catalog", () => {
    expect(summary.total).toBe(catalog.programs.length);
  });

  it("reads as one sentence with an Oxford comma", () => {
    const sentence = coverageSentence(summary);
    expect(sentence).toMatch(/^SNAP in \d+ states?, /);
    expect(sentence).toMatch(/, and \d+ other programs?$/);
  });

  it("lists SNAP states as postal codes that match the catalog", () => {
    const snap = summary.groups.find((g) => g.key === "snap")!;
    const expected = catalog.programs
      .filter((p) => p.program_id === "snap")
      .map((p) => p.jurisdiction.slice(3).toUpperCase())
      .sort();
    expect(snap.members).toEqual(expected);
  });
});

describe("coverageSentence", () => {
  const group = (phrase: string) => ({ key: "other" as const, heading: "", phrase, members: [], count: 1 });
  it("joins one, two, and three phrases", () => {
    expect(coverageSentence({ total: 1, incomplete: 0, groups: [group("A")] })).toBe("A");
    expect(coverageSentence({ total: 2, incomplete: 0, groups: [group("A"), group("B")] })).toBe("A and B");
    expect(coverageSentence({ total: 3, incomplete: 0, groups: [group("A"), group("B"), group("C")] })).toBe(
      "A, B, and C"
    );
  });
});
