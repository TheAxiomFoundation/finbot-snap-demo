import { describe, expect, it } from "vitest";

import { appliedAmendment, formulaVersionAt } from "./amendments";
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
// under the amended formula must name the amended statute the engine applied.
// It names the law only: comparing the two laws for given facts would rest on
// the pinned pre-amendment formula, which review rounds 2–4 showed flattens
// 7 CFR 273.4(a) and reads some facts through flags its successor reads
// differently, so no result says whether the amendment changed an outcome.
const CHECK = "snap_member_citizenship_or_alien_status_eligible";
const MODULE = "us:regulations/7-cfr/273/4";
const AMENDED = { legal_id: "us:statutes/7/2015/f", citation: "7 U.S.C. 2015(f)", applies_from: "2025-08-01" };
const programs = getCatalog().programs.filter((p) => p.outputs.some((o) => o.name === CHECK));
const fl = getProgram("us-fl-snap")!;
const context = { toolCallId: "refugee-amendment-test", messages: [] };
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

/** An `amended_by` that names the law applied and nothing else. */
const citesOnly = (ref: unknown, at?: string) => {
  expect(ref, at).toMatchObject(AMENDED);
  expect(Object.keys(ref as object).sort(), at).toEqual(["applies_from", "citation", "effective", "enacted_by", "legal_id", "note", "url"]);
};
// The comparison fields earlier rounds of this change emitted.
const COMPARISON = /"(changed_outcome|earlier|changed_for_members|unchanged_for_members)"/;

// AZ, CA and NY default member_is_us_citizen to true (a fixture default), so
// a refugee there must say otherwise; FL's default is false.
const REFUGEE: Facts = { member_is_refugee: true, member_is_us_citizen: false };
// A lawful permanent resident with none of the five-year-wait exceptions.
const WAITING_LPR: Facts = { member_is_us_citizen: false, member_is_lawful_permanent_resident: true };
// Review counterexamples to the removed comparison, kept as regressions.
// Round 3: an adult parolee with 40 credited quarters who is not a permanent
// resident and has not met the five-year period.
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
// Round 4: an adult parolee past the five-year period, without the
// redundant "subject to the wait" flag both earlier encodings read.
const PAROLEE_PAST_WAIT: Facts = {
  member_is_us_citizen: false,
  member_age: 60,
  member_is_under_age_eighteen: false,
  member_is_lawful_permanent_resident: false,
  member_is_paroled_into_united_states_for_at_least_one_year: true,
  member_parole_period_years: 1,
  qualified_alien_five_year_status_period_met: true,
};
// Round 4: an LPR with 40 quarters as a number, which the amended detailed
// rule reads through a separate boolean.
const LPR_40Q: Facts = {
  member_is_us_citizen: false,
  member_age: 60,
  member_is_under_age_eighteen: false,
  member_is_lawful_permanent_resident: true,
  member_qualifying_quarters: 40,
};
// Each ground of 7 CFR 273.4(a) alone, and with a status, for the sweep.
const GROUNDS = [
  "member_has_eligible_military_connection",
  "member_receives_blindness_or_disability_benefits",
  "member_was_lawfully_residing_on_1996_08_22_and_born_on_or_before_1931_08_22",
  "member_is_under_age_eighteen",
  "member_is_qualified_alien_with_forty_qualifying_quarters",
  "member_is_amerasian_immigrant",
];
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
  ...Object.fromEntries(GROUNDS.flatMap((slot) => [
    [slot, { [slot]: true }],
    [`${slot}+lpr`, { [slot]: true, member_is_lawful_permanent_resident: true }],
    [`${slot}+refugee`, { [slot]: true, member_is_refugee: true }],
  ])),
  parolee_40q: PAROLEE_40Q,
  parolee_past_wait: PAROLEE_PAST_WAIT,
  lpr_40q: LPR_40Q,
  five_year_flag: { member_is_qualified_alien_subject_to_five_year_wait: true, qualified_alien_five_year_status_period_met: true },
  five_year_lpr: { member_is_lawful_permanent_resident: true, qualified_alien_five_year_status_period_met: true },
  lpr: { member_is_lawful_permanent_resident: true },
  refugee_without_documents: { member_is_refugee: true, alien_status_documentation_missing_or_unwilling: true },
};

const starter = (program: CatalogProgram, period = "2026-10", member: Facts = REFUGEE) =>
  computeProgram({ program, period, facts: { household_size: 1 }, members: [{ facts: member }] });
const compute = (members: Facts[], extra: Partial<Parameters<typeof computeProgram>[0]> = {}) =>
  computeProgram({ program: fl, period: "2026-10", facts: { household_size: members.length }, members: members.map((facts) => ({ facts })), ...extra });
const lookup = async (facts: Facts, period = "2026-10", output = CHECK) =>
  (await tools.lookup_value.execute!({ program: "us-fl-snap", output, period, members: [{ facts }] }, context)) as Record<string, unknown>;
const citizenshipFailure = (failed: Array<{ name: string; amended_by?: unknown }> | undefined) => failed?.find((f) => f.name === CHECK);
type Entry = { name: string; value?: unknown; amended_by?: Record<string, unknown> };
type Result = Awaited<ReturnType<typeof computeProgram>>;
/** The check where it fails in member checks: a failed_because entry (FL
 *  gates members on snap_member_eligible), or the gate itself (CO). */
const failedHere = (checks: Entry[] = []): Entry[] =>
  checks.flatMap((c) => [c, ...((c as { failed_because?: Entry[] }).failed_because ?? [])])
    .filter((f) => f.name === CHECK && (f.value === undefined || f.value === "not_holds"));
const memberEntries = (result: Result): Entry[] => (result.member_checks ?? []).flatMap((m) => failedHere(m.checks as Entry[]));
const householdEntries = (result: Result): Entry[] =>
  result.outputs.flatMap((o) => [o, ...(o.zero_because ?? [])]).flatMap((o) => o.failed_because ?? []).filter((f) => f.name === CHECK) as Entry[];
/** Every object in a result, walking objects and arrays. */
const nodes = (result: unknown): Entry[] => {
  const found: Entry[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      found.push(node as Entry);
      Object.values(node).forEach(walk);
    }
  };
  walk(result);
  return found;
};
/** Every place the check fails, wherever the result puts one: a
 *  failed_because entry (on outputs, member checks, zero_because gates) or a
 *  failed check of that name. */
const citizenshipFailures = (result: unknown): Entry[] => [
  ...nodes(result).filter((n) => n.name === CHECK && n.value === "not_holds"),
  ...nodes(result).flatMap((n) => ((n as { failed_because?: Entry[] }).failed_because ?? []).filter((f) => f?.name === CHECK)),
];

it("covers every SNAP program that presents the check", () => {
  expect(programs.map((p) => p.slug)).toContain("us-fl-snap");
  for (const p of programs) expect(p.outputs.find((o) => o.name === CHECK)!.id?.split("#")[0]).toBe(MODULE);
});

it("dates a lookup's amendment by the month the engine runs a year-only request", () => {
  const rule = fl.outputs.find((o) => o.name === CHECK)!;
  // All 11 programs certify a January today, so "2025" runs in 2025-01,
  // under the pre-amendment formula.
  expect(lookupAmendment(fl, rule, "2025")).toBeUndefined();
  citesOnly(lookupAmendment(fl, rule, "2026"));
  citesOnly(lookupAmendment(fl, rule, "2026-10"));
  expect(lookupAmendment(fl, rule, "2025-07")).toBeUndefined();
  // One certified in October runs "2025" in 2025-10, under the amended one.
  citesOnly(lookupAmendment({ ...fl, period: "2026-10" }, rule, "2025"));
});

it("tells the model which law applied, and not to say why the facts fail it", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain("When a failed check (a sub-check in `failed_because`, a member check, an output) or a lookup carries `amended_by`, the engine evaluated that check under the amended provision for this period");
  expect(prompt).toContain("`amended_by` says which law applied, not why the facts fail it");
  expect(prompt).toContain("never say the amendment is why the person fails the check, that they would have met it before, or that the amendment changed nothing for them");
  expect(prompt).toContain("say how the texts differ, citing both, without applying the earlier text to the user's facts");
  expect(prompt).toContain("The engine stops evaluating a judgment at its first condition that fails, so a failed verdict says nothing about the conditions after it");
  expect(prompt).toContain("a member check or output that reports some of them was evaluated on its own and does not cover the rest");
  expect(prompt).toContain("never say the person or household would otherwise be eligible");
  expect(prompt).toContain("Axiom's encoded rules apply the amended provision to periods starting on or after its `applies_from`");
  expect(prompt).toContain("for a period that ends before `effective` the regulation as it stood then is the law in force: quote the fetched text as that law only when the note says this text states it");
  // Wording earlier rounds removed: the comparison fields, a verdict-level
  // cause, and the July 2025 claim.
  expect(prompt).not.toMatch(/changed_outcome|changed_for_members|unchanged_for_members/);
  expect(prompt).not.toContain("give the amendment as the reason for the verdict");
  expect(prompt).not.toContain("When true, the amendment is the reason");
  expect(prompt).not.toContain("it applies only to periods starting on or after its `applies_from`");
  // Round 5: scoped to the judgment's own evaluation, and no certifying of
  // whatever text fetch_citation returned.
  expect(prompt).not.toContain("so it did not evaluate the conditions after it");
  expect(prompt).not.toContain("cite the regulation text as the law then in force");
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
      for (const failed of failures) citesOnly(failed.amended_by);
      expect(JSON.stringify(result)).not.toMatch(COMPARISON);
      expect(result.citations[0]).toEqual({ id: AMENDED.legal_id, url: "https://app.axiom-foundation.org/us/statute/7/2015/f" });
    }, 30_000);
  }

  it("says nothing about the amendment for a citizen", async () => {
    const result = await starter(fl, "2026-10", { member_is_us_citizen: true });
    expect(citizenshipFailures(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("amended_by");
    expect(result.citations.map((c) => c.id)).not.toContain(AMENDED.legal_id);
  }, 30_000);

  // Sweep: each ground of 7 CFR 273.4(a), alone and with a status, in every
  // program. The check carries amended_by wherever it fails under the
  // amended formula, only failed rules of the amended module carry one, and
  // nothing compares the two laws. (Full computes for months in 2025 fail in
  // most programs on parameters with no value yet, such as
  // snap_member_general_work_requirement_exempt_scalar_limit, so the
  // pre-amendment side is the June tests below and amendments.test.ts.)
  it("cites the amended statute wherever the check fails under the amended formula", async () => {
    const names = Object.keys(PROFILES);
    const members = names.map((k) => ({ facts: { member_is_us_citizen: false, ...PROFILES[k] } }));
    for (const program of programs) {
      const result = await computeProgram({ program, period: "2026-10", facts: { household_size: names.length }, members });
      const failures = citizenshipFailures(result);
      expect(failures.length, program.slug).toBeGreaterThan(0);
      for (const failed of failures) citesOnly(failed.amended_by, program.slug);
      for (const owner of nodes(result).filter((n) => n.amended_by)) {
        const at = `${program.slug} ${owner.name}`;
        expect(program.outputs.find((o) => o.name === owner.name)?.id?.split("#")[0], at).toBe(MODULE);
        expect(owner.value === undefined || owner.value === "not_holds", at).toBe(true);
        citesOnly(owner.amended_by, at);
      }
      expect(JSON.stringify(result), program.slug).not.toMatch(COMPARISON);
    }
  }, 120_000);

  it("cites without comparing for each review counterexample to the removed comparison", async () => {
    // Round 3: the flat earlier formula passed this parolee on the
    // 40-quarter flag. Round 4: both earlier encodings failed the parolee
    // past the wait, whom the 2025 CFR's (a)(6)(iii) allowed.
    for (const facts of [PAROLEE_40Q, PAROLEE_PAST_WAIT]) {
      const at = JSON.stringify(facts);
      const now = await lookup(facts);
      expect(now.value, at).toBe("not_holds");
      citesOnly(now.amended_by, at);
      // The redundant flag both earlier encodings read changes nothing.
      expect((await lookup({ ...facts, member_is_qualified_alien_subject_to_five_year_wait: true })).amended_by, at).toEqual(now.amended_by);
      const result = await compute([facts]);
      expect(memberEntries(result).length, at).toBe(1);
      for (const failed of citizenshipFailures(result)) citesOnly(failed.amended_by, at);
      expect(JSON.stringify(result), at).not.toMatch(COMPARISON);
    }
    // Round 4: the amended detailed (a)(6) rule reads 40 quarters through a
    // boolean, the earlier one through a number. A lookup of the detailed
    // rule names the law it applied, whichever input the facts use.
    const detailed = "snap_member_qualified_alien_status_eligible";
    const asNumber = await lookup(LPR_40Q, "2026-10", detailed);
    citesOnly(asNumber.amended_by);
    const asFlag = await lookup({ ...LPR_40Q, member_is_qualified_alien_with_forty_qualifying_quarters: true }, "2026-10", detailed);
    expect(asFlag.value).toBe("holds");
    expect(asFlag.amended_by).toEqual(asNumber.amended_by);
    expect((await lookup(LPR_40Q, "2025-06", detailed)).amended_by).toBeUndefined();
    // Round 4: Colorado with the check as an extra output.
    const co = await computeProgram({
      program: getProgram("us-co-snap")!,
      period: "2026-10",
      facts: { household_size: 2 },
      members: [{ facts: { member_is_us_citizen: false } }, { facts: REFUGEE }],
      extraOutputs: [CHECK],
    });
    expect(co.outputs.find((o) => o.name === CHECK)).toMatchObject({ value: "not_holds" });
    citesOnly(co.outputs.find((o) => o.name === CHECK)!.amended_by);
    for (const failed of citizenshipFailures(co)) citesOnly(failed.amended_by);
    expect(JSON.stringify(co)).not.toMatch(COMPARISON);
  }, 60_000);

  it("annotates every member's failure the same way, and each household entry", async () => {
    // A refugee and a member with no status fail the check alike today, and
    // nothing about the earlier law tells them apart, so member 2's checks
    // equal member 1's.
    const mixed = await compute([REFUGEE, { member_is_us_citizen: false }]);
    expect(mixed.member_checks?.map((m) => m.same_as)).toEqual([undefined, 1]);
    citesOnly(citizenshipFailure(memberCheck(mixed, 1, "snap_member_eligible").failed_because)?.amended_by);
    expect(householdEntries(mixed).length).toBeGreaterThan(0);
    for (const entry of householdEntries(mixed)) citesOnly(entry.amended_by);

    const refugees = await compute([REFUGEE, REFUGEE]);
    expect(refugees.member_checks?.[1]).toEqual({ member: 2, same_as: 1 });
    for (const entry of [...memberEntries(refugees), ...householdEntries(refugees)]) citesOnly(entry.amended_by);
  }, 30_000);

  it("annotates the direct 7 CFR 273.4 gates member by member", async () => {
    // Arizona, California, Colorado and New York gate each member on the
    // check itself, so the failed gate carries amended_by.
    for (const slug of ["us-az-snap", "us-ca-snap", "us-co-snap", "us-ny-snap"]) {
      const result = await computeProgram({
        program: getProgram(slug)!,
        period: "2026-10",
        facts: { household_size: 2 },
        members: [{ facts: { member_is_us_citizen: false } }, { facts: REFUGEE }],
      });
      for (const m of [1, 2]) {
        const gate = memberCheck(result, m, CHECK);
        expect(gate, `${slug} ${m}`).toMatchObject({ value: "not_holds" });
        citesOnly(gate.amended_by, `${slug} ${m}`);
      }
      expect(result.citations[0].id, slug).toBe(AMENDED.legal_id);
    }
    // A waiting LPR fails first on an unversioned sub-rule the amendment did
    // not change; only a gate that is the amended check itself carries one.
    for (const program of programs) {
      const lpr = await starter(program, "2026-10", WAITING_LPR);
      expect(JSON.stringify(lpr), program.slug).toContain('"failed_because":[{"name":"eligibility_based_on_earlier_less_rigorous_alien_status_preserved"');
      const gate = lpr.member_checks?.[0].checks?.find((c) => c.name === CHECK);
      if (gate) {
        citesOnly(gate.amended_by, program.slug);
        expect(JSON.stringify(lpr).match(/"amended_by"/g), program.slug).toHaveLength(1);
      } else {
        expect(JSON.stringify(lpr), program.slug).not.toContain("amended_by");
      }
    }
  }, 60_000);

  it("keeps amended_by on member checks whatever extra outputs the compute asked for", async () => {
    const result = await compute([REFUGEE], { extraOutputs: ["snap_standard_income_eligible", "snap_net_monthly_income"] });
    citesOnly(memberEntries(result)[0].amended_by);
  }, 30_000);

  it("annotates a requested output of the check itself when it fails", async () => {
    // Asked for as an output, the check is member 1's own judgment.
    const refugee = await compute([REFUGEE, { member_is_us_citizen: false }], { extraOutputs: [CHECK] });
    expect(refugee.outputs.find((o) => o.name === CHECK)).toMatchObject({ value: "not_holds" });
    citesOnly(refugee.outputs.find((o) => o.name === CHECK)!.amended_by);
    const citizen = await compute([{ member_is_us_citizen: true }], { extraOutputs: [CHECK] });
    expect(citizen.outputs.find((o) => o.name === CHECK)).toMatchObject({ value: "holds" });
    expect(citizen.outputs.find((o) => o.name === CHECK)).not.toHaveProperty("amended_by");
    // With the check as the only output there are no member checks, and the
    // output's own amended_by is the only one: it still leads the Sources.
    const alone = await compute([REFUGEE], { outputsOverride: [CHECK] });
    expect(alone.member_checks).toBeUndefined();
    expect(alone.outputs).toEqual([expect.objectContaining({ name: CHECK, value: "not_holds" })]);
    expect(alone.outputs[0]).not.toHaveProperty("failed_because");
    citesOnly(alone.outputs[0].amended_by);
    expect(alone.citations[0]).toEqual({ id: AMENDED.legal_id, url: "https://app.axiom-foundation.org/us/statute/7/2015/f" });
  }, 30_000);

  it("dates a year-only compute by the month the engine runs", async () => {
    const year = (program: CatalogProgram, period: string) =>
      computeProgram({ program, period, facts: { household_size: 1 }, members: [{ facts: REFUGEE }] });
    // FL certifies January: "2026" runs in 2026-01, under the amended formula.
    citesOnly(memberEntries(await year(fl, "2026"))[0].amended_by);
    // One certified in October runs "2025" in 2025-10, under the amended one
    // ("2025" in January is the pure lookupAmendment test above: the engine
    // cannot run a full FL compute there).
    citesOnly(memberEntries(await year({ ...fl, period: "2026-10" }, "2025"))[0].amended_by);
  }, 30_000);

  it("leaves a June 2025 failure on the pre-amendment rule unannotated", async () => {
    // No status at all fails both versions; only the later one is the amended statute.
    const june = await starter(fl, "2025-06", { member_is_us_citizen: false });
    expect(citizenshipFailure(memberCheck(june, 1, "snap_member_eligible").failed_because)).toBeDefined();
    for (const failed of citizenshipFailures(june)) expect(failed.amended_by).toBeUndefined();
    const october = await starter(fl, "2026-10", { member_is_us_citizen: false });
    citesOnly(citizenshipFailure(memberCheck(october, 1, "snap_member_eligible").failed_because)?.amended_by);
  }, 30_000);

  it("carries amended_by on lookup_value whatever the value, from the period alone", async () => {
    const refugee = await lookup(REFUGEE);
    expect(refugee.value).toBe("not_holds");
    expect(refugee.url).toBe("https://app.axiom-foundation.org/us/regulation/7/273/4");
    citesOnly(refugee.amended_by);
    expect(refugee.amended_by).toMatchObject({ url: "https://app.axiom-foundation.org/us/statute/7/2015/f" });
    // A permanent resident under 18 meets the amended check: the lookup
    // still names the law it applied.
    const lprChild = await lookup({ ...WAITING_LPR, member_is_under_age_eighteen: true });
    expect(lprChild.value).toBe("holds");
    expect(lprChild.amended_by).toEqual(refugee.amended_by);
    const lpr = await lookup(WAITING_LPR);
    expect(lpr.value).toBe("not_holds");
    expect(lpr.amended_by).toEqual(refugee.amended_by);
    const before = await lookup(REFUGEE, "2025-06");
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
