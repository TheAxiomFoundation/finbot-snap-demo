import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { getCatalog } from "./catalog";
import { coverageSentence, incompleteSentence, jurisdictionCoverageStatus, programCoverageStatus, programCoverageStatuses, summarizeCoverage } from "./coverage";

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
  it("labels every program with exactly its catalog flags", () => {
    fc.assert(fc.property(program, (p) => {
      const status = programCoverageStatus(p);
      expect(status).toMatch(/^Encoded · /);
      if (p.acknowledged_incomplete.length) {
        expect(status).toBe(`Encoded · results flagged incomplete: ${p.acknowledged_incomplete.join(", ")}`);
      } else {
        expect(status).toBe("Encoded · no results flagged incomplete in this release; encodings may still have gaps");
      }
    }));
  });

  it("reports jurisdiction flags from the programs in that jurisdiction", () => {
    fc.assert(fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
      const status = jurisdictionCoverageStatus(programs);
      const flagged = programs.filter((p) => p.acknowledged_incomplete.length).length;
      expect(status).toBe(flagged
        ? `${flagged} of ${programs.length} encoded programs have results flagged incomplete`
        : "No results flagged incomplete in this release; encodings may still have gaps");
    }));
  });
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

  it("counts flagged programs: headline-flagged ≤ any-flagged ≤ total, and groups sum to the total", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
        const summary = summarizeCoverage(programs);
        const headline = programs.filter((p) => p.acknowledged_incomplete.includes(p.primary_output)).length;
        const any = programs.filter((p) => p.acknowledged_incomplete.length > 0).length;
        expect(summary.incomplete).toBe(headline);
        expect(summary.flagged).toBe(any);
        expect(summary.incomplete).toBeLessThanOrEqual(summary.flagged);
        expect(summary.flagged).toBeLessThanOrEqual(summary.total);
        expect(summary.groups.reduce((n, g) => n + g.flagged, 0)).toBe(summary.flagged);
        for (const g of summary.groups) expect(g.flagged).toBeLessThanOrEqual(g.count);
      })
    );
  });

  it("states the flagged counts exactly, and says nothing when nothing is flagged", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
        const summary = summarizeCoverage(programs);
        const sentence = incompleteSentence(summary);
        if (summary.flagged === 0) {
          expect(sentence).toBe("");
          return;
        }
        const numbers = (sentence.match(/\d+/g) ?? []).map(Number);
        expect(numbers).toContain(summary.flagged === summary.incomplete ? summary.incomplete : summary.flagged);
        if (summary.incomplete > 0) expect(numbers).toContain(summary.incomplete);
      })
    );
  });

  it("only claims a state count for state-level programs, and counts each state once", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 60 }), (programs) => {
        for (const group of summarizeCoverage(programs).groups) {
          if (group.key === "snap" || group.key === "cash" || group.key === "state-income-tax") {
            expect(group.members.every((m) => /^[A-Z]{2}$/.test(m))).toBe(true);
            expect(new Set(group.members).size).toBe(group.members.length);
            // The number in the phrase is the number of distinct states listed.
            expect(Number(/\d+/.exec(group.phrase)?.[0])).toBe(group.members.length);
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
    const statuses = programCoverageStatuses(catalog.programs);
    expect(Object.keys(statuses)).toHaveLength(catalog.programs.length);
    for (const p of catalog.programs) expect(statuses[p.slug]).toBe(programCoverageStatus(p));
  });

  it("reads as one sentence with an Oxford comma", () => {
    const sentence = coverageSentence(summary);
    expect(sentence).toMatch(/^SNAP in \d+ states?, /);
    expect(sentence).toMatch(/, and \d+ other programs?$/);
  });

  it("counts flags the way the catalog does", () => {
    const flagged = catalog.programs.filter((p) => p.acknowledged_incomplete.length > 0).length;
    const headline = catalog.programs.filter((p) => p.acknowledged_incomplete.includes(p.primary_output)).length;
    expect(summary.flagged).toBe(flagged);
    expect(summary.incomplete).toBe(headline);
    expect(incompleteSentence(summary)).toContain(String(flagged));
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
  const group = (phrase: string) => ({ key: "other" as const, heading: "", phrase, members: [], count: 1, flagged: 0 });
  it("joins one, two, and three phrases", () => {
    expect(coverageSentence({ total: 1, incomplete: 0, flagged: 0, groups: [group("A")] })).toBe("A");
    expect(coverageSentence({ total: 2, incomplete: 0, flagged: 0, groups: [group("A"), group("B")] })).toBe("A and B");
    expect(coverageSentence({ total: 3, incomplete: 0, flagged: 0, groups: [group("A"), group("B"), group("C")] })).toBe(
      "A, B, and C"
    );
  });
});
