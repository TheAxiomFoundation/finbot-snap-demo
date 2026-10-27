import { describe, expect, it } from "vitest";

import { appliedAmendment, formulaVersionAt } from "./amendments";
import { getCatalog, getProgram, type CatalogProgram } from "./catalog";
import { computeProgram, type Facts } from "./request-builder";
import { tools } from "./tools";
import { engineAvailable, memberCheck } from "../../scripts/snap-scenarios";

// The refugee starter ("I have refugee status but no green card yet, and I
// live in Florida with no income. Can I get SNAP?") gets not_holds from the
// engine because the 7 CFR 273.4 citizenship check applies 7 U.S.C. 2015(f)
// as amended by P.L. 119-21, §10108 from August 2025. The check's own source
// is the CFR section, whose eCFR text still lists refugees, so in 10 saved
// Aspen runs the replies hedged on the verdict. Every place the check fails
// must name the amended statute the engine applied.
const CHECK = "snap_member_citizenship_or_alien_status_eligible";
const AMENDED = { legal_id: "us:statutes/7/2015/f", citation: "7 U.S.C. 2015(f)", applies_from: "2025-08-01" };
const programs = getCatalog().programs.filter((p) => p.outputs.some((o) => o.name === CHECK));
const fl = getProgram("us-fl-snap")!;
const context = { toolCallId: "refugee-amendment-test", messages: [] };
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

// AZ, CA and NY default member_is_us_citizen to true (a fixture default), so
// a refugee there must say otherwise; FL's default is false.
const REFUGEE: Facts = { member_is_refugee: true, member_is_us_citizen: false };
const starter = (program: CatalogProgram, period = "2026-10", member: Facts = REFUGEE) =>
  computeProgram({ program, period, facts: { household_size: 1 }, members: [{ facts: member }] });
const citizenshipFailure = (failed: Array<{ name: string; amended_by?: unknown }> | undefined) => failed?.find((f) => f.name === CHECK);
/** Every failed_because entry naming the check, wherever the result puts one
 *  (outputs, member checks, zero_because gates). */
const citizenshipFailures = (result: unknown): Array<{ amended_by?: unknown }> => {
  const found: Array<{ amended_by?: unknown }> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "failed_because" && Array.isArray(value)) found.push(...value.filter((f) => f?.name === CHECK));
        walk(value);
      }
    }
  };
  walk(result);
  return found;
};

it("covers every SNAP program that presents the check", () => {
  expect(programs.map((p) => p.slug)).toContain("us-fl-snap");
  for (const p of programs) expect(p.outputs.find((o) => o.name === CHECK)!.id?.split("#")[0]).toBe("us:regulations/7-cfr/273/4");
});

describe.skipIf(!hasEngine)("real-engine refugee starter", () => {
  for (const program of programs) {
    it(`${program.slug}: names the amended statute behind the failed check, October 2026`, async () => {
      const failures = citizenshipFailures(await starter(program));
      expect(failures.length).toBeGreaterThan(0);
      for (const failed of failures) expect(failed.amended_by).toMatchObject(AMENDED);
    }, 30_000);
  }

  it("says nothing about the amendment for a citizen", async () => {
    const result = await starter(fl, "2026-10", { member_is_us_citizen: true });
    expect(citizenshipFailures(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("amended_by");
  }, 30_000);

  it("leaves a June 2025 failure on the pre-amendment rule unannotated", async () => {
    // No status at all fails both versions; only the later one is the amended statute.
    const june = await starter(fl, "2025-06", { member_is_us_citizen: false });
    expect(citizenshipFailure(memberCheck(june, 1, "snap_member_eligible").failed_because)).toBeDefined();
    for (const failed of citizenshipFailures(june)) expect(failed.amended_by).toBeUndefined();
    const october = await starter(fl, "2026-10", { member_is_us_citizen: false });
    expect(citizenshipFailure(memberCheck(october, 1, "snap_member_eligible").failed_because)?.amended_by).toMatchObject(AMENDED);
  }, 30_000);

  it("carries amended_by on lookup_value, and fetch_citation's guidance points at it", async () => {
    const result = (await tools.lookup_value.execute!(
      { program: "us-fl-snap", output: CHECK, period: "2026-10", members: [{ facts: REFUGEE }] },
      context
    )) as Record<string, unknown>;
    expect(result.value).toBe("not_holds");
    expect(result.url).toBe("https://app.axiom-foundation.org/us/regulation/7/273/4");
    expect(result.amended_by).toMatchObject({ ...AMENDED, url: "https://app.axiom-foundation.org/us/statute/7/2015/f" });
    const before = (await tools.lookup_value.execute!(
      { program: "us-fl-snap", output: CHECK, period: "2025-06", members: [{ facts: REFUGEE }] },
      context
    )) as Record<string, unknown>;
    expect(before.value).toBe("holds");
    expect(before.amended_by).toBeUndefined();
  }, 30_000);

  // Differential: the catalog's formula versions (which drive amended_by)
  // against the engine's own selection. Under the pre-amendment formula a
  // refugee meets the check; under the amended one they do not; between the
  // two the engine has no formula. So the engine's answer for every month
  // tells which version it ran, and that must be the one the catalog names.
  it("selects, month by month, the formula version the catalog records", async () => {
    const months = Array.from({ length: 48 }, (_, i) => `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
    for (const program of programs) {
      const rule = program.outputs.find((o) => o.name === CHECK)!;
      for (const period of months) {
        const date = `${period}-01`;
        const version = formulaVersionAt(rule.versions!, date);
        let engine: "holds" | "not_holds" | "no_formula";
        try {
          const r = await computeProgram({
            program,
            period,
            facts: { household_size: 1 },
            members: [{ facts: REFUGEE }],
            outputsOverride: [CHECK],
          });
          engine = r.outputs.find((o) => o.name === CHECK)!.value as "holds" | "not_holds";
        } catch (err) {
          expect(String(err)).toContain(`\`${CHECK}\` has no formula version at ${date}`);
          engine = "no_formula";
        }
        const expected = !version ? "no_formula" : appliedAmendment(rule, date) ? "not_holds" : "holds";
        expect(engine, `${program.slug} ${period}`).toBe(expected);
      }
    }
  }, 120_000);
});
