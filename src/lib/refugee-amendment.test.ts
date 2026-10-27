import { describe, expect, it } from "vitest";

import { STATUTORY_AMENDMENTS, appliedAmendment, formulaVersionAt } from "./amendments";
import { getCatalog, getProgram, type CatalogProgram } from "./catalog";
import { readOutput, runCompiled } from "./engine";
import { buildSystemPrompt } from "./prompts";
import { buildRequest, computeProgram, lookupAmendment, queryKey, type Facts } from "./request-builder";
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
// The module's branch-by-branch rules for the paragraph the check flattens.
const DETAIL = STATUTORY_AMENDMENTS[0].earlier_formula_detail![0].detailed_by;
// The round-3 counterexample: an adult parolee with 40 credited quarters who
// is not a permanent resident and has not met the five-year period. The flat
// pre-amendment formula passes them on the 40-quarter flag; the module's
// 7 CFR 273.4(a)(6)(ii)(A) rule requires permanent residence.
const PAROLEE_40Q: Facts = {
  member_is_us_citizen: false,
  member_age: 30,
  member_is_under_age_eighteen: false,
  member_is_lawful_permanent_resident: false,
  qualified_alien_five_year_status_period_met: false,
  member_is_paroled_into_united_states_for_at_least_one_year: true,
  member_parole_period_years: 1,
  member_is_qualified_alien_with_forty_qualifying_quarters: true,
  member_qualifying_quarters: 40,
};
// Grounds the flat formula accepts with no qualified-alien status.
const FLAT_ONLY = [
  "member_has_eligible_military_connection",
  "member_receives_blindness_or_disability_benefits",
  "member_was_lawfully_residing_on_1996_08_22_and_born_on_or_before_1931_08_22",
  "member_is_under_age_eighteen",
  "member_is_qualified_alien_with_forty_qualifying_quarters",
  "member_is_amerasian_immigrant",
];
// Each ground of 7 CFR 273.4(a) alone, and with a status, for the
// differential sweep.
const PROFILES: Record<string, Facts> = {
  none: {},
  citizen: { member_is_us_citizen: true },
  national: { member_is_us_noncitizen_national: true },
  refugee: { member_is_refugee: true },
  asylee: { member_is_asylee: true },
  deportation_withheld: { member_has_deportation_or_removal_withheld: true },
  cuban_haitian: { member_is_cuban_or_haitian_entrant: true },
  american_indian: { member_is_american_indian_born_in_canada_or_recognized_indian_tribe_member: true },
  hmong: { member_is_hmong_or_highland_laotian_qualifying_person_or_family_member: true },
  trafficking: { member_is_trafficking_victim_or_qualifying_family_member: true },
  ...Object.fromEntries(FLAT_ONLY.flatMap((slot) => [
    [slot, { [slot]: true }],
    [`${slot}+lpr`, { [slot]: true, member_is_lawful_permanent_resident: true }],
    [`${slot}+refugee`, { [slot]: true, member_is_refugee: true }],
  ])),
  forty_quarters_lpr_adult: { ...PAROLEE_40Q, member_is_paroled_into_united_states_for_at_least_one_year: false, member_is_lawful_permanent_resident: true },
  parolee_40q: PAROLEE_40Q,
  five_year_flag: { member_is_qualified_alien_subject_to_five_year_wait: true, qualified_alien_five_year_status_period_met: true },
  five_year_lpr: { member_is_lawful_permanent_resident: true, qualified_alien_five_year_status_period_met: true },
  lpr: { member_is_lawful_permanent_resident: true },
  refugee_without_documents: { member_is_refugee: true, alien_status_documentation_missing_or_unwilling: true },
};
const starter = (program: CatalogProgram, period = "2026-10", member: Facts = REFUGEE) =>
  computeProgram({ program, period, facts: { household_size: 1 }, members: [{ facts: member }] });
const citizenshipFailure = (failed: Array<{ name: string; amended_by?: unknown }> | undefined) => failed?.find((f) => f.name === CHECK);
type Entry = { name: string; value?: unknown; amended_by?: Record<string, unknown> };
type Result = Awaited<ReturnType<typeof computeProgram>>;
/** The check where it fails in member checks: a failed_because entry (FL
 *  gates members on snap_member_eligible), or the gate itself (CO). */
const failedHere = (checks: Entry[] = []): Entry[] =>
  checks.flatMap((c) => [c, ...((c as { failed_because?: Entry[] }).failed_because ?? [])])
    .filter((f) => f.name === CHECK && (f.value === undefined || f.value === "not_holds"));
const memberEntries = (result: Result): Entry[] => (result.member_checks ?? []).flatMap((m) => failedHere(m.checks as Entry[]));
/** Member `m`'s entry for the check, following same_as. */
const memberEntry = (result: Result, m: number): Entry | undefined => {
  const entry = result.member_checks?.find((c) => c.member === m);
  const own = entry?.same_as ? result.member_checks?.find((c) => c.member === entry.same_as) : entry;
  return failedHere(own?.checks as Entry[])[0];
};
const householdEntries = (result: Result): Entry[] =>
  result.outputs.flatMap((o) => [o, ...(o.zero_because ?? [])]).flatMap((o) => o.failed_because ?? []).filter((f) => f.name === CHECK) as Entry[];
/** Every place the check fails, wherever the result puts one: a
 *  failed_because entry (on outputs, member checks, zero_because gates) or a
 *  failed check of that name. */
const citizenshipFailures = (result: unknown): Array<{ amended_by?: unknown }> => {
  const found: Array<{ amended_by?: unknown }> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      const entry = node as Entry;
      if (entry.name === CHECK && entry.value === "not_holds") found.push(entry);
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
      expect(memberEntries(result).length).toBeGreaterThan(0);
      // Nothing else carries the check.
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
      // whose formula the amendment did not change. Only a member gate that
      // is the amended check itself (AZ, CA, CO, NY) carries amended_by,
      // and it says unchanged.
      const lpr = await starter(program, "2026-10", WAITING_LPR);
      expect(JSON.stringify(lpr), program.slug).toContain('"failed_because":[{"name":"eligibility_based_on_earlier_less_rigorous_alien_status_preserved"');
      const gate = lpr.member_checks?.[0].checks?.find((c) => c.name === CHECK);
      if (gate) {
        expect(gate.amended_by, program.slug).toMatchObject(UNCHANGED);
        expect(JSON.stringify(lpr).match(/"amended_by"/g), program.slug).toHaveLength(1);
      } else {
        expect(JSON.stringify(lpr), program.slug).not.toContain("amended_by");
      }
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

  it("annotates Colorado's direct 7 CFR 273.4 gates member by member", async () => {
    // Colorado gates each member on the check itself, so the failed gate
    // carries amended_by (round 3: the household listed member 1 only).
    const co = getProgram("us-co-snap")!;
    const result = await computeProgram({
      program: co,
      period: "2026-10",
      facts: { household_size: 2 },
      members: [{ facts: { member_is_us_citizen: false } }, { facts: REFUGEE }],
    });
    expect(memberCheck(result, 1, CHECK)).toMatchObject({ value: "not_holds", amended_by: UNCHANGED });
    expect(memberCheck(result, 2, CHECK)).toMatchObject({ value: "not_holds", amended_by: CHANGED });
    expect(result.member_checks?.map((m) => m.same_as)).toEqual([undefined, undefined]);
    expect(householdEntries(result).length).toBeGreaterThan(0);
    for (const entry of householdEntries(result)) expect(entry.amended_by).toMatchObject(household([2], [1]));
    expect(result.citations[0].id).toBe(AMENDED.legal_id);
  }, 30_000);

  it("claims nothing where the flat earlier formula and the module's own rules disagree", async () => {
    const lookup = async (period: string, facts: Facts, output = CHECK) =>
      (await tools.lookup_value.execute!({ program: "us-fl-snap", output, period, members: [{ facts }] }, context)) as Record<string, unknown>;
    // The disagreement is in the pinned rules: the flat formula passes the
    // parolee in June 2025, the module's (a)(6) rule fails them. When
    // rulespec-us guards the flat formula, the first expectation fails.
    expect((await lookup("2025-06", PAROLEE_40Q)).value).toBe("holds");
    expect((await lookup("2025-06", PAROLEE_40Q, "snap_member_qualified_alien_status_eligible")).value).toBe("not_holds");
    const now = await lookup("2026-10", PAROLEE_40Q);
    expect(now.value).toBe("not_holds");
    expect(now.amended_by).toMatchObject(AMENDED);
    expect(now.amended_by).not.toHaveProperty("changed_outcome");
    expect(now.amended_by).not.toHaveProperty("earlier");
    for (const facts of [PAROLEE_40Q, ...FLAT_ONLY.map((slot) => ({ member_is_us_citizen: false, [slot]: true }))]) {
      const result = await compute([facts]);
      const [entry] = memberEntries(result);
      expect(entry.amended_by, JSON.stringify(facts)).toMatchObject(AMENDED);
      expect(entry.amended_by, JSON.stringify(facts)).not.toHaveProperty("changed_outcome");
      for (const h of householdEntries(result)) expect(h.amended_by, JSON.stringify(facts)).not.toHaveProperty("changed_for_members");
    }
    // The other direction: the flat formula fails a permanent resident past
    // the five-year period unless a separate wait flag is set, and the
    // module's (a)(6) rule passes them. No claim either way.
    const pastWait = await lookup("2026-10", { ...WAITING_LPR, qualified_alien_five_year_status_period_met: true });
    expect(pastWait.value).toBe("holds");
    expect(pastWait.amended_by).not.toHaveProperty("changed_outcome");
    // A refugee without documents fails both then (the flat formula reads
    // 7 CFR 273.4(b)(2); the detailed rules do not): no claim.
    const undocumented = await compute([{ ...REFUGEE, alien_status_documentation_missing_or_unwilling: true }]);
    expect(memberEntries(undocumented)[0].amended_by).not.toHaveProperty("changed_outcome");
  }, 60_000);

  it("claims an earlier answer where both encodings agree, with a status or without", async () => {
    // A refugee met the check on the refugee branch, which the amendment
    // removed, whatever other ground they have.
    for (const slot of FLAT_ONLY) {
      const refugee = await compute([{ ...REFUGEE, [slot]: true }]);
      expect(memberEntries(refugee)[0].amended_by, slot).toMatchObject(CHANGED);
    }
    // A permanent resident under 18 meets both encodings then and the
    // check now: unchanged.
    const lprChild = (await tools.lookup_value.execute!(
      { program: "us-fl-snap", output: CHECK, period: "2026-10", members: [{ facts: { ...WAITING_LPR, member_is_under_age_eighteen: true } }] },
      context
    )) as Record<string, unknown>;
    expect(lprChild.value).toBe("holds");
    expect(lprChild.amended_by).toMatchObject({ ...AMENDED, changed_outcome: false, earlier: { period: "2025-06", value: "holds" } });
  }, 60_000);

  // Differential: every claim against the engine's own June 2025 answers for
  // the flat check and the module's detailed rules, in every program and for
  // each ground of 7 CFR 273.4(a). A member gets an earlier answer exactly
  // when the two encodings agree, and it is theirs.
  it("matches every earlier claim to the module's two encodings of the earlier law", async () => {
    const names = Object.keys(PROFILES);
    const members = names.map((k) => ({ facts: { member_is_us_citizen: false, ...PROFILES[k] } }));
    for (const program of programs) {
      const keys = [CHECK, ...DETAIL].map((name) => queryKey(program.outputs.find((o) => o.name === name)!));
      const built = buildRequest({ program, period: "2025-06", facts: { household_size: names.length }, members, outputsOverride: [CHECK, ...DETAIL] });
      const period = built.request.queries[0].period;
      const june = await runCompiled(program.slug, {
        ...built.request,
        queries: names.map((_, i) => ({ entity_id: `person:${i + 1}`, period, outputs: keys })),
      });
      const now = await computeProgram({ program, period: "2026-10", facts: { household_size: names.length }, members });
      const expected = { changed: [] as number[], unchanged: [] as number[] };
      let withheld = 0;
      names.forEach((name, i) => {
        const at = `${program.slug} ${name}`;
        const result = june.results.find((r) => r.entity_id === `person:${i + 1}`)!;
        const [flat, ...detail] = keys.map((key) => readOutput(result.outputs[key]).outcome);
        const entry = memberEntry(now, i + 1);
        if (!entry) return; // holds now, or fails an earlier condition first
        expect(entry.amended_by, at).toMatchObject(AMENDED);
        if ((flat === "holds") === detail.includes("holds")) {
          expect(entry.amended_by, at).toMatchObject({ changed_outcome: flat === "holds", earlier: { period: "2025-06", value: flat } });
          (flat === "holds" ? expected.changed : expected.unchanged).push(i + 1);
        } else {
          expect(entry.amended_by, at).not.toHaveProperty("changed_outcome");
          expect(entry.amended_by, at).not.toHaveProperty("earlier");
          withheld++;
        }
      });
      expect(expected.changed.length, program.slug).toBeGreaterThan(0);
      expect(expected.unchanged.length, program.slug).toBeGreaterThan(0);
      expect(withheld, program.slug).toBeGreaterThan(0);
      for (const entry of householdEntries(now)) expect(entry.amended_by, program.slug).toMatchObject(household(expected.changed, expected.unchanged));
    }
  }, 120_000);

  it("runs the earlier formula for the check alone, whatever extra outputs the compute asked for", async () => {
    const result = await compute([REFUGEE], { extraOutputs: ["snap_standard_income_eligible", "snap_net_monthly_income"] });
    expect(memberEntries(result)[0].amended_by).toMatchObject(CHANGED);
  }, 30_000);

  it("says on a requested output of the check itself whether the amendment changed it", async () => {
    // Asked for as an output, the check is member 1's own judgment.
    const refugee = await compute([REFUGEE, { member_is_us_citizen: false }], { extraOutputs: [CHECK] });
    expect(refugee.outputs.find((o) => o.name === CHECK)).toMatchObject({ value: "not_holds", amended_by: CHANGED });
    const none = await compute([{ member_is_us_citizen: false }, REFUGEE], { extraOutputs: [CHECK] });
    expect(none.outputs.find((o) => o.name === CHECK)).toMatchObject({ value: "not_holds", amended_by: UNCHANGED });
    const citizen = await compute([{ member_is_us_citizen: true }], { extraOutputs: [CHECK] });
    expect(citizen.outputs.find((o) => o.name === CHECK)).not.toHaveProperty("amended_by");
    // With the check as the only output there are no member checks: the
    // output alone puts member 1 in the earlier run.
    const alone = await compute([REFUGEE], { outputsOverride: [CHECK] });
    expect(alone.member_checks).toBeUndefined();
    expect(alone.outputs).toEqual([expect.objectContaining({ name: CHECK, value: "not_holds", amended_by: expect.objectContaining(CHANGED) })]);
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
    expect(prompt).toContain("When a failed check (a sub-check in `failed_because`, a member check, an output) or a lookup carries `amended_by`");
    expect(prompt).toContain("`changed_outcome` on a member's check, an output or a lookup, and on a household-level sub-check `changed_for_members` / `unchanged_for_members`");
    expect(prompt).toContain("the module's encodings of the earlier law disagree for those facts");
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
