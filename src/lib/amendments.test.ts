import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { allCorpusPaths, getCatalog, getProgram, type CatalogOutput } from "./catalog";
import {
  STATUTORY_AMENDMENTS,
  amendmentForModule,
  amendmentRef,
  appliedAmendment,
  earlierFormulaEnd,
  formulaVersionAt,
  withEarlierOutcome,
  withMemberOutcomes,
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

  it("details each earlier formula with rules of the same module, entity and grain, in force for that formula's span", () => {
    for (const amendment of STATUTORY_AMENDMENTS) {
      for (const entry of amendment.earlier_formula_detail ?? []) {
        expect(entry.detailed_by.length, entry.rule).toBeGreaterThan(0);
        const presenting = getCatalog().programs.filter((p) => p.outputs.some((o) => o.name === entry.rule));
        expect(presenting.length, entry.rule).toBeGreaterThan(0);
        for (const program of presenting) {
          const rule = program.outputs.find((o) => o.name === entry.rule)!;
          expect(moduleOf(rule), `${program.slug} ${entry.rule}`).toBe(amendment.module);
          const end = earlierFormulaEnd(rule, amendment);
          expect(end, `${program.slug} ${entry.rule}`).toBeTruthy();
          for (const name of entry.detailed_by) {
            const detail = program.outputs.find((o) => o.name === name);
            expect(detail, `${program.slug} ${name}`).toBeDefined();
            expect(moduleOf(detail!), `${program.slug} ${name}`).toBe(amendment.module);
            expect([detail!.entity, detail!.semantics, detail!.period], `${program.slug} ${name}`).toEqual([
              rule.entity,
              "judgment",
              rule.period,
            ]);
            // Unversioned, or its own earlier formula covers the same last day.
            if (detail!.versions) expect(formulaVersionAt(detail!.versions, end!), `${program.slug} ${name}`).toBeDefined();
          }
        }
      }
    }
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
    expect(ref).not.toHaveProperty("changed_outcome");
    expect(earlierFormulaEnd(rule, amendment)).toBe("2025-06-30");
  });
});

describe("the earlier-formula run behind changed_outcome", () => {
  it("runs, for every changed rule, a day the pre-amendment formula was in force", () => {
    for (const amendment of STATUTORY_AMENDMENTS) {
      for (const { program, output } of outputs.filter(({ output }) => moduleOf(output) === amendment.module && output.versions)) {
        const end = earlierFormulaEnd(output, amendment);
        if (!end) continue;
        expect(end < amendment.encoded_from, `${program} ${output.name}`).toBe(true);
        const version = formulaVersionAt(output.versions!, end);
        expect(version, `${program} ${output.name}`).toBeDefined();
        expect(appliedAmendment(output, end), `${program} ${output.name}`).toBeUndefined();
      }
    }
  });

  it("isolates the formula change: no program presenting an amended module has a period-dependent default", () => {
    // The earlier-formula run keeps the request's facts and moves only the
    // period, so a slot whose default differs between the two periods could
    // make changed_outcome report the default's change as the amendment's.
    // The catalog records which rules read a slot only for assumed slots,
    // so check every slot: a dated default here needs a look at what reads it.
    for (const amendment of STATUTORY_AMENDMENTS) {
      const presenting = getCatalog().programs.filter((p) => p.outputs.some((o) => moduleOf(o) === amendment.module));
      expect(presenting.length).toBeGreaterThan(0);
      for (const program of presenting) {
        const dated = Object.values(program.inputs).flat().filter((slot) => slot.default_by_period);
        expect(dated.map((slot) => slot.name), program.slug).toEqual([]);
      }
    }
  });

  const amendment = STATUTORY_AMENDMENTS[0];
  const value = fc.oneof(fc.constantFrom("holds", "not_holds"), fc.integer({ min: 0, max: 2000 }));

  it("reports changed_outcome exactly when the earlier value differs, keeping the citation", () => {
    fc.assert(
      fc.property(value, value, (now, earlier) => {
        const ref = amendmentRef(amendment, "https://example.test/x");
        const out = withEarlierOutcome(ref, now, { period: "2025-06", value: earlier });
        expect(out.changed_outcome).toBe(now !== earlier);
        expect(out.earlier).toEqual({ period: "2025-06", value: earlier });
        expect(out.note.startsWith(ref.note)).toBe(true);
        const { note: _n, earlier: _e, changed_outcome: _c, ...rest } = out;
        const { note: _rn, ...refRest } = ref;
        expect(rest).toEqual(refRest);
        expect(out.note.includes("the amendment did not change it")).toBe(now === earlier);
      }),
      { seed: 20261030, numRuns: 300 }
    );
  });

  it("says which way the amendment moved a judgment", () => {
    const ref = amendmentRef(amendment, "https://example.test/x");
    expect(withEarlierOutcome(ref, "not_holds", { period: "2025-06", value: "holds" }).note).toMatch(
      /run for 2025-06\) the same facts met this check, so the amendment is why it fails now\.$/
    );
    expect(withEarlierOutcome(ref, "holds", { period: "2025-06", value: "not_holds" }).note).toMatch(
      /the same facts failed this check, so the amendment is why it holds now\.$/
    );
    expect(withEarlierOutcome(ref, 0, { period: "2025-06", value: 298 }).note).toMatch(
      /the same facts gave 298, so the amendment changed this result\.$/
    );
  });
});

describe("household-level outcomes", () => {
  const amendment = STATUTORY_AMENDMENTS[0];
  const ref = amendmentRef(amendment, "https://example.test/x");
  const members = fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { maxLength: 12 });

  it("list each member once, keep the citation, and add one sentence", () => {
    fc.assert(
      fc.property(members, fc.integer({ min: 0, max: 12 }), (all, cut) => {
        const changed = all.slice(0, cut);
        const unchanged = all.slice(cut);
        const out = withMemberOutcomes(ref, "2025-06", changed, unchanged);
        if (all.length === 0) {
          expect(out).toBe(ref);
          return;
        }
        expect(out.changed_for_members).toEqual(changed);
        expect(out.unchanged_for_members).toEqual(unchanged);
        expect(out).not.toHaveProperty("changed_outcome");
        const { note, changed_for_members: _c, unchanged_for_members: _u, ...rest } = out;
        const { note: refNote, ...refRest } = ref;
        expect(rest).toEqual(refRest);
        expect(note.startsWith(`${refNote} Under the formula in force before the amendment (run for 2025-06), `)).toBe(true);
        expect(note.includes("so the amendment is why")).toBe(changed.length > 0);
        expect(note.includes("failed it then too")).toBe(unchanged.length > 0);
      }),
      { seed: 20261026, numRuns: 300 }
    );
  });

  it("name the members in the sentence", () => {
    expect(withMemberOutcomes(ref, "2025-06", [1], [2]).note).toMatch(
      /member 1 met this check, so the amendment is why that member fails it now; member 2 failed it then too\.$/
    );
    expect(withMemberOutcomes(ref, "2025-06", [1, 3], []).note).toMatch(/members 1 and 3 met this check, so the amendment is why they fail it now\.$/);
    expect(withMemberOutcomes(ref, "2025-06", [], [1, 2, 4]).note).toMatch(/members 1, 2, 4 failed it then too\.$/);
  });
});
