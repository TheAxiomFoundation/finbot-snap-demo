import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { allCorpusPaths, getCatalog, getProgram, type CatalogOutput } from "./catalog";
import {
  STATUTORY_AMENDMENTS,
  amendmentForModule,
  amendmentRef,
  appliedAmendment,
  formulaVersionAt,
} from "./amendments";

const CITIZENSHIP_CHECK = "snap_member_citizenship_or_alien_status_eligible";
const outputs = getCatalog().programs.flatMap((program) => program.outputs.map((output) => ({ program: program.slug, output })));
const versioned = outputs.filter(({ output }) => output.versions);
const corpusPaths = allCorpusPaths();
const moduleOf = (output: CatalogOutput) => output.id?.split("#")[0];
const isoDate = fc
  .date({ min: new Date("1990-01-01T00:00:00Z"), max: new Date("2035-12-31T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
/** The first day of the month on or after `date`. */
const firstMonthStartFrom = (date: string) => {
  if (date.endsWith("-01")) return date;
  const [y, m] = date.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

describe("catalog formula versions", () => {
  it("are recorded for the pinned release's dated rules", () => {
    expect(versioned.length).toBeGreaterThan(0);
    const fl = getProgram("us-fl-snap")!.outputs.find((o) => o.name === CITIZENSHIP_CHECK)!;
    expect(fl.versions).toEqual([
      { effective_from: "0001-01-01", effective_to: "2025-06-30" },
      { effective_from: "2025-08-01" },
    ]);
  });

  it("are ordered, disjoint, and open-ended only last", () => {
    for (const { program, output } of versioned) {
      const versions = output.versions!;
      versions.forEach((v, i) => {
        const where = `${program} ${output.name} version ${i}`;
        if (v.effective_to) expect(v.effective_to >= v.effective_from, where).toBe(true);
        else expect(i, `${where} is open-ended but not last`).toBe(versions.length - 1);
        if (i > 0) expect(v.effective_from > versions[i - 1].effective_to!, `${where} overlaps`).toBe(true);
      });
    }
  });

  it("put at most one version in force on any day, and formulaVersionAt finds it", () => {
    fc.assert(
      fc.property(fc.constantFrom(...versioned), isoDate, ({ output }, date) => {
        const holding = output.versions!.filter((v) => v.effective_from <= date && (!v.effective_to || date <= v.effective_to));
        expect(holding.length).toBeLessThanOrEqual(1);
        expect(formulaVersionAt(output.versions!, date)).toBe(holding[0]);
      }),
      { seed: 20261026, numRuns: 500 }
    );
  });
});

describe("statutory amendments registry", () => {
  it("names each module once", () => {
    const modules = STATUTORY_AMENDMENTS.map((a) => a.module);
    expect(new Set(modules).size).toBe(modules.length);
  });

  for (const amendment of STATUTORY_AMENDMENTS) {
    describe(amendment.module, () => {
      const moduleRules = outputs.filter(({ output }) => moduleOf(output) === amendment.module);
      const changed = moduleRules.filter(({ output }) =>
        output.versions?.some((v) => v.effective_from >= amendment.effective)
      );

      it("cites an encoded module and an encoded amended provision", () => {
        expect(corpusPaths[amendment.module]).toBeDefined();
        expect(corpusPaths[amendment.provision.legal_id]).toBeDefined();
        expect(moduleRules.length).toBeGreaterThan(0);
      });

      it("starts the encoded rules at the first month start on or after the amendment", () => {
        expect(amendment.encoded_from).toBe(firstMonthStartFrom(amendment.effective));
      });

      it("matches the formula switch in every program that presents the module", () => {
        // The registry's dates are claims about the pinned encoding: a pin
        // bump that moves the switch must fail here, not ship a wrong note.
        expect(changed.length).toBeGreaterThan(0);
        for (const { program, output } of changed) {
          const starts = output.versions!.map((v) => v.effective_from).filter((d) => d >= amendment.effective);
          expect(starts, `${program} ${output.name}`).toEqual([amendment.encoded_from]);
        }
      });

      it("quotes evidence for its dates and enacting law", () => {
        expect(amendment.evidence.length).toBeGreaterThan(0);
        for (const e of amendment.evidence) expect(e.excerpt.trim().length).toBeGreaterThan(0);
        const quoted = amendment.evidence.map((e) => e.excerpt).join(" ");
        expect(quoted).toContain(amendment.enacted_by.match(/\d+-\d+/)![0]);
        expect(quoted).toContain(amendment.enacted_by.match(/§(\d+)/)![1]);
      });

      it("applies to a changed rule exactly when its post-amendment formula is in force", () => {
        fc.assert(
          fc.property(fc.constantFrom(...changed), isoDate, ({ output }, date) => {
            const version = formulaVersionAt(output.versions!, date);
            const expected = version !== undefined && version.effective_from >= amendment.encoded_from;
            expect(appliedAmendment(output, date) === amendment).toBe(expected);
          }),
          { seed: 20261027, numRuns: 400 }
        );
      });

      it("once applied, stays applied for every later in-force date", () => {
        fc.assert(
          fc.property(fc.constantFrom(...changed), isoDate, isoDate, ({ output }, a, b) => {
            const [early, late] = a <= b ? [a, b] : [b, a];
            if (appliedAmendment(output, early) && formulaVersionAt(output.versions!, late)) {
              expect(appliedAmendment(output, late)).toBe(amendment);
            }
          }),
          { seed: 20261028, numRuns: 400 }
        );
      });
    });
  }

  it("never applies to a rule outside a registered module, or one with no dated formula", () => {
    fc.assert(
      fc.property(fc.constantFrom(...outputs), isoDate, ({ output }, date) => {
        const registered = output.id ? amendmentForModule(output.id) : undefined;
        if (!registered || !output.versions) expect(appliedAmendment(output, date)).toBeUndefined();
      }),
      { seed: 20261029, numRuns: 1000 }
    );
  });

  it("marks the Florida refugee check from August 2025, and not before", () => {
    const rule = getProgram("us-fl-snap")!.outputs.find((o) => o.name === CITIZENSHIP_CHECK)!;
    const amendment = amendmentForModule(rule.id!)!;
    expect(appliedAmendment(rule, "2026-10-01")).toBe(amendment);
    expect(appliedAmendment(rule, "2025-08-01")).toBe(amendment);
    expect(appliedAmendment(rule, "2025-07-01")).toBeUndefined(); // no formula in force
    expect(appliedAmendment(rule, "2025-06-01")).toBeUndefined();
    const ref = amendmentRef(amendment, "https://example.test/x");
    expect(ref).toMatchObject({
      legal_id: "us:statutes/7/2015/f",
      citation: "7 U.S.C. 2015(f)",
      enacted_by: "P.L. 119-21, §10108",
      effective: "2025-07-04",
      applies_from: "2025-08-01",
    });
    expect(ref.note).toContain("7 U.S.C. 2015(f) as amended by P.L. 119-21, §10108");
  });
});
