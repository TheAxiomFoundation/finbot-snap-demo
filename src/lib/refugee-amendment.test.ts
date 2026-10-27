import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { STATUTORY_AMENDMENTS, appliedAmendment, formulaVersionAt } from "./amendments";
import { getCatalog, getProgram, type CatalogProgram } from "./catalog";
import { buildSystemPrompt } from "./prompts";
import { computeProgram, lookupAmendment, type Facts } from "./request-builder";
import { tools } from "./tools";
import { engineAvailable, memberCheck } from "../../scripts/snap-scenarios";

// The refugee starter ("I have refugee status but no green card yet, and I
// live in Florida with no income. Can I get SNAP?") gets not_holds from the
// engine because the 7 CFR 273.4 citizenship check applies 7 U.S.C. 2015(f)
// as amended by P.L. 119-21, §10108 from August 2025. The check's own source
// is the CFR section, whose eCFR text still lists refugees, so in 10 saved
// Aspen runs the replies hedged on the verdict. Every place the check fails
// must name the amended statute the engine applied, and say whether the
// amendment changed that check's result: the engine runs the same facts
// under the formula in force before it (2025-06).
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
// A lawful permanent resident with none of the five-year-wait exceptions
// fails the check under both formulas (the reviewer's counterexample).
const WAITING_LPR: Facts = { member_is_us_citizen: false, member_is_lawful_permanent_resident: true };
const CHANGED = { ...AMENDED, changed_outcome: true, earlier: { period: "2025-06", value: "holds" } };
const UNCHANGED = { ...AMENDED, changed_outcome: false, earlier: { period: "2025-06", value: "not_holds" } };
// A household-level entry lists the failing members each way instead.
const household = (changed: number[], unchanged: number[]) => ({ ...AMENDED, changed_for_members: changed, unchanged_for_members: unchanged });
// The four grounds the pre-amendment formula accepts with no status.
const GAP = STATUTORY_AMENDMENTS[0].earlier_formula_gaps![0].inputs;
const starter = (program: CatalogProgram, period = "2026-10", member: Facts = REFUGEE) =>
  computeProgram({ program, period, facts: { household_size: 1 }, members: [{ facts: member }] });
const citizenshipFailure = (failed: Array<{ name: string; amended_by?: unknown }> | undefined) => failed?.find((f) => f.name === CHECK);
type Entry = { name: string; amended_by?: Record<string, unknown> };
/** The check's failed_because entries on member checks, and on household
 *  outputs and their zero_because gates. */
const memberEntries = (result: Awaited<ReturnType<typeof computeProgram>>): Entry[] =>
  (result.member_checks ?? []).flatMap((m) => (m.checks ?? []).flatMap((c) => c.failed_because ?? [])).filter((f) => f.name === CHECK) as Entry[];
const householdEntries = (result: Awaited<ReturnType<typeof computeProgram>>): Entry[] =>
  result.outputs.flatMap((o) => [o, ...(o.zero_because ?? [])]).flatMap((o) => o.failed_because ?? []).filter((f) => f.name === CHECK) as Entry[];
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
      const result = await starter(program);
      const failures = citizenshipFailures(result);
      expect(failures.length).toBeGreaterThan(0);
      // Nothing else carries the check (CO has no member checks).
      expect(memberEntries(result).length + householdEntries(result).length).toBe(failures.length);
      for (const failed of memberEntries(result)) expect(failed.amended_by).toMatchObject(CHANGED);
      for (const failed of householdEntries(result)) {
        expect(failed.amended_by).toMatchObject(household([1], []));
        expect(failed.amended_by).not.toHaveProperty("changed_outcome");
      }
      expect(result.citations[0]).toEqual({ id: AMENDED.legal_id, url: "https://app.axiom-foundation.org/us/statute/7/2015/f" });
    }, 30_000);
  }

  it("says nothing about the amendment for a citizen", async () => {
    const result = await starter(fl, "2026-10", { member_is_us_citizen: true });
    expect(citizenshipFailures(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("amended_by");
    expect(result.citations.map((c) => c.id)).not.toContain(AMENDED.legal_id);
  }, 30_000);

  it("does not credit the amendment when the facts fail the earlier formula too", async () => {
    for (const program of programs) {
      // A member with no status fails the check under both formulas.
      const none = await starter(program, "2026-10", { member_is_us_citizen: false });
      expect(citizenshipFailures(none).length, program.slug).toBeGreaterThan(0);
      for (const failed of memberEntries(none)) expect(failed.amended_by, program.slug).toMatchObject(UNCHANGED);
      for (const failed of householdEntries(none)) expect(failed.amended_by, program.slug).toMatchObject(household([], [1]));
      // A waiting LPR's deepest failure is the unversioned sub-rule
      // eligibility_based_on_earlier_less_rigorous_alien_status_preserved,
      // whose formula the amendment did not change: no amended_by at all.
      const lpr = await starter(program, "2026-10", WAITING_LPR);
      expect(JSON.stringify(lpr), program.slug).toContain('"failed_because":[{"name":"eligibility_based_on_earlier_less_rigorous_alien_status_preserved"');
      expect(JSON.stringify(lpr), program.slug).not.toContain("amended_by");
    }
  }, 60_000);

  const compute = (members: Facts[], extra: Partial<Parameters<typeof computeProgram>[0]> = {}) =>
    computeProgram({ program: fl, period: "2026-10", facts: { household_size: members.length }, members: members.map((facts) => ({ facts })), ...extra });

  it("attributes each member separately, and lists them each way on a household entry", async () => {
    // A refugee and an undocumented member fail identically now (their checks
    // would collapse to same_as), but only the refugee met the earlier formula.
    const mixed = await compute([REFUGEE, { member_is_us_citizen: false }]);
    expect(mixed.member_checks?.map((m) => m.same_as)).toEqual([undefined, undefined]);
    expect(citizenshipFailure(memberCheck(mixed, 1, "snap_member_eligible").failed_because)?.amended_by).toMatchObject(CHANGED);
    expect(citizenshipFailure(memberCheck(mixed, 2, "snap_member_eligible").failed_because)?.amended_by).toMatchObject(UNCHANGED);
    for (const entry of householdEntries(mixed)) {
      expect(entry.amended_by).toMatchObject(household([1], [2]));
      expect(entry.amended_by).not.toHaveProperty("changed_outcome");
      expect(entry.amended_by?.note).toMatch(/member 1 met this check, so the amendment is why that member fails it now; member 2 failed it then too\.$/);
    }

    const refugees = await compute([REFUGEE, REFUGEE]);
    expect(refugees.member_checks?.[1]).toEqual({ member: 2, same_as: 1 });
    for (const entry of householdEntries(refugees)) expect(entry.amended_by).toMatchObject(household([1, 2], []));

    // A split-off member points at the first member equal to it both ways
    // rather than repeating its checks.
    const three = await compute([{ member_is_us_citizen: false }, REFUGEE, REFUGEE]);
    expect(three.member_checks?.map((m) => m.same_as)).toEqual([undefined, undefined, 2]);
    for (const entry of householdEntries(three)) expect(entry.amended_by).toMatchObject(household([2, 3], [1]));
  }, 30_000);

  it("claims no change from the pre-amendment formula's four status-free grounds", async () => {
    for (const slot of GAP) {
      // The gap is real in the pinned formula: the ground alone, with no
      // status, meets the check in June 2025. When rulespec-us guards it,
      // this fails and the registry entry should go.
      const june = (await tools.lookup_value.execute!(
        { program: "us-fl-snap", output: CHECK, period: "2025-06", members: [{ facts: { member_is_us_citizen: false, [slot]: true } }] },
        context
      )) as Record<string, unknown>;
      expect(june.value, slot).toBe("holds");
      // So in October 2026 nobody is told the amendment is why they fail.
      const statusFree = await compute([{ member_is_us_citizen: false, [slot]: true }]);
      const [entry] = memberEntries(statusFree);
      expect(entry.amended_by, slot).toMatchObject(AMENDED);
      expect(entry.amended_by, slot).not.toHaveProperty("changed_outcome");
      expect(entry.amended_by, slot).not.toHaveProperty("earlier");
      for (const h of householdEntries(statusFree)) expect(h.amended_by, slot).not.toHaveProperty("changed_for_members");
      // A refugee with the same ground met the earlier formula on the
      // refugee branch, which the amendment removed.
      const refugee = await compute([{ ...REFUGEE, [slot]: true }]);
      expect(memberEntries(refugee)[0].amended_by, slot).toMatchObject(CHANGED);
    }
    // A lawful permanent resident under 18 holds now; the earlier formula
    // gives no answer that does not lean on the under-18 ground alone.
    const lprChild = (await tools.lookup_value.execute!(
      { program: "us-fl-snap", output: CHECK, period: "2026-10", members: [{ facts: { ...WAITING_LPR, member_is_under_age_eighteen: true } }] },
      context
    )) as Record<string, unknown>;
    expect(lprChild.value).toBe("holds");
    expect(lprChild.amended_by).toMatchObject(AMENDED);
    expect(lprChild.amended_by).not.toHaveProperty("changed_outcome");
  }, 60_000);

  // The recheck sets the gap inputs false and trusts a "not_holds" from the
  // first run; both rest on the inputs only ever adding ways to hold.
  it("finds each gap input in the pinned pre-amendment formula, never negated", () => {
    type Expr = { kind?: string; name?: string; [key: string]: unknown };
    const dir = process.env.AXIOM_ARTIFACTS_DIR ?? path.resolve("engine/artifacts");
    for (const program of programs) {
      const artifact = JSON.parse(readFileSync(path.join(dir, `${program.slug}.compiled.json`), "utf8"));
      const rule = artifact.program.derived.find((r: { name: string }) => r.name === CHECK);
      const earlier = rule.versions.find((v: { effective_to?: string }) => v.effective_to === "2025-06-30").expr;
      const reads = new Map<string, boolean>(); // input → read under a negation
      const walk = (node: unknown, negated: boolean) => {
        if (Array.isArray(node)) return node.forEach((n) => walk(n, negated));
        if (!node || typeof node !== "object") return;
        const expr = node as Expr;
        if (expr.kind === "input" && expr.name) reads.set(expr.name, (reads.get(expr.name) ?? false) || negated);
        // `input eq true` reads the input as is; any other comparison may not.
        const right = expr.right as { kind?: string; value?: { value?: unknown } } | undefined;
        const asIs = expr.kind !== "comparison" || (expr.op === "eq" && right?.kind === "literal" && right.value?.value === true);
        for (const value of Object.values(expr)) walk(value, negated || expr.kind === "not" || !asIs);
      };
      walk(earlier, false);
      for (const slot of GAP) expect(reads.get(slot), `${program.slug} ${slot}`).toBe(false);
    }
  });

  it("runs the earlier formula for the check alone, whatever extra outputs the compute asked for", async () => {
    const result = await compute([REFUGEE], { extraOutputs: ["snap_standard_income_eligible", "snap_net_monthly_income"] });
    expect(memberEntries(result)[0].amended_by).toMatchObject(CHANGED);
  }, 30_000);

  it("dates a year-only request by the month the engine runs, and runs the earlier formula in its own month", async () => {
    const result = await computeProgram({ program: fl, period: "2026", facts: { household_size: 1 }, members: [{ facts: REFUGEE }] });
    expect(memberEntries(result)[0].amended_by).toMatchObject(CHANGED);
    // All 11 programs certify a January today. One certified in October
    // runs "2025" in 2025-10, under the amended formula: the amendment
    // applies, and the earlier run must still be June, not "2025" again.
    const october = { ...fl, period: "2026-10" };
    const year = await computeProgram({ program: october, period: "2025", facts: { household_size: 1 }, members: [{ facts: REFUGEE }] });
    expect(memberEntries(year)[0].amended_by).toMatchObject(CHANGED);
    const rule = fl.outputs.find((o) => o.name === CHECK)!;
    const lookup = await lookupAmendment({ program: october, period: "2025", members: [{ facts: REFUGEE }] }, rule, "2025", "not_holds");
    expect(lookup).toMatchObject(CHANGED);
  }, 30_000);

  it("tells the model the outcome is about the check, not the verdict", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("`changed_outcome` on a member's check or a lookup, and on a household-level entry `changed_for_members` / `unchanged_for_members`");
    expect(prompt).toContain("do not present the amendment as the cause");
    expect(prompt).toContain("never that they or the household would otherwise be eligible");
    expect(prompt).toContain("Axiom's encoded rules apply the amended provision to periods starting on or after its `applies_from`");
    expect(prompt).toContain("for a period that ends before `effective` cite the regulation text as the law then in force");
    // Wording earlier rounds removed: a verdict-level cause, a "fail under
    // either formula" said of checks that hold, and the July 2025 claim.
    expect(prompt).not.toContain("give the amendment as the reason for the verdict");
    expect(prompt).not.toContain("When true, the amendment is the reason");
    expect(prompt).not.toContain("the facts fail the check under either formula");
    expect(prompt).not.toContain("it applies only to periods starting on or after its `applies_from`");
  });

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
    expect(result.amended_by).toMatchObject({ ...CHANGED, url: "https://app.axiom-foundation.org/us/statute/7/2015/f" });
    const lpr = (await tools.lookup_value.execute!(
      { program: "us-fl-snap", output: CHECK, period: "2026-10", members: [{ facts: WAITING_LPR }] },
      context
    )) as Record<string, unknown>;
    expect(lpr.value).toBe("not_holds");
    expect(lpr.amended_by).toMatchObject(UNCHANGED);
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
