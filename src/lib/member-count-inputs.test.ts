import fc from "fast-check";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import { getCatalog, getProgram, type CatalogProgram } from "./catalog";
import { runCompiled } from "./engine";
import {
  NoMemberEntityError,
  buildRequest,
  computeProgram,
  memberCountSlotNames,
  shapeResult,
  type BuildOptions,
  type Facts,
} from "./request-builder";
import { engineAvailable } from "../../scripts/snap-scenarios";

const POVERTY_SLOT = "poverty_income_guideline_for_household_size";
const INDIGENCE_OUTPUT = "indigent_sponsored_alien_unable_to_obtain_food_and_shelter";
const snapPrograms = getCatalog().programs.filter((program) => program.program_id === "snap");
const noMemberPrograms = getCatalog().programs.filter((program) => program.member_entity === null);
const withCount = noMemberPrograms.filter((program) => memberCountSlotNames(program).length > 0);
const withoutCount = noMemberPrograms.filter((program) => memberCountSlotNames(program).length === 0);
const blank = (size: number) => Array.from({ length: size }, () => ({}));
const countFacts = (program: CatalogProgram, size: number) =>
  Object.fromEntries(memberCountSlotNames(program).map((name) => [name, size]));
const refusal = (options: BuildOptions): NoMemberEntityError => {
  try {
    buildRequest(options);
  } catch (err) {
    if (err instanceof NoMemberEntityError) return err;
    throw err;
  }
  throw new Error(`buildRequest accepted members[] on ${options.program.slug}`);
};
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

describe("household count inputs", () => {
  it("preserves requests across equivalent explicit and synthesized SNAP members without inventing money", () => {
    fc.assert(fc.property(fc.constantFrom(...snapPrograms.map((program) => program.slug)), fc.integer({ min: 1, max: 8 }), (slug, size) => {
      const program = getProgram(slug)!;
      // North Carolina also exposes a separate FNS-unit count. Supply the same
      // factual count through both household representations.
      const facts = { household_size: size, ...(program.slug === "us-nc-snap" && { fns_unit_size: size }) };
      const options = { program, period: "2026-09", facts, outputsOverride: [INDIGENCE_OUTPUT] };
      const synthesized = buildRequest(options);
      const explicit = buildRequest({ ...options, members: Array.from({ length: size }, () => ({})) });
      expect(isDeepStrictEqual(explicit.request, synthesized.request)).toBe(true);
      expect(explicit.applied.facts_applied).not.toHaveProperty(POVERTY_SLOT);
      const povertyRecords = explicit.request.dataset.inputs.filter((record) => record.name.endsWith(`#input.${POVERTY_SLOT}`));
      expect(povertyRecords.length).toBeGreaterThan(0);
      expect(povertyRecords.every((record) => record.value.value === "0")).toBe(true);
    }), { seed: 20261009, numRuns: 50 });
  }, 30_000);

  it("does not use a supplied monetary guideline to synthesize member headcount", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 100000 }), (guideline) => {
      const built = buildRequest({ program: getProgram("us-ny-snap")!, period: "2026-09", facts: { [POVERTY_SLOT]: guideline } });
      expect(built.applied.member_count).toBe(1);
      expect(built.applied.facts_applied[POVERTY_SLOT]).toBe(guideline);
    }), { seed: 20261009, numRuns: 100 });
  });

  it("retains automatic household count from an explicit member list", () => {
    const built = buildRequest({ program: getProgram("us-ny-snap")!, period: "2026-09", members: [{}, {}, {}] });
    expect(built.applied.member_count).toBe(3);
    expect(built.applied.facts_applied.household_size).toBe(3);
    expect(built.applied.facts_applied).not.toHaveProperty(POVERTY_SLOT);
  });

  it("keeps an explicit count fact over a different members list where a member entity exists", () => {
    // Today's member-entity behaviour, unchanged: the count fact wins.
    const built = buildRequest({
      program: getProgram("us-ny-snap")!, period: "2026-09", facts: { household_size: 5 }, members: blank(3),
    });
    expect(built.applied.member_count).toBe(3);
    expect(built.applied.facts_applied.household_size).toBe(5);
  });
});

describe("members[] on programs with no member entity", () => {
  it("finds a verified count input on exactly the TANF/TCA programs that have one", () => {
    expect(Object.fromEntries(withCount.map((program) => [program.slug, memberCountSlotNames(program)]))).toEqual({
      "us-ak-tanf": ["assistance_unit_size"],
      "us-al-tanf": ["assistance_unit_size"],
      "us-ar-tanf": ["assistance_unit_size"],
      "us-de-tanf": ["assistance_unit_member_count"],
      "us-fl-tca": ["filing_unit_size"],
      "us-ga-tanf": ["assistance_unit_member_count"],
      "us-ks-tanf": ["assistance_plan_person_count"],
      "us-md-tca": ["household_size"],
      "us-me-tanf": ["tanf_household_size"],
      "us-ny-tanf": ["family_size", "number_of_persons_in_household"],
      "us-tx-tanf": ["tanf_family_size"],
      "us-ut-tanf": ["household_size"],
    });
    expect(withoutCount.length).toBe(10);
  });

  it("keeps member-entity programs on the counts they already synthesize members from", () => {
    // A count input on a member-entity program also synthesizes members, so a
    // name added for the no-member TANF programs must not appear there.
    const names = new Set(getCatalog().programs.filter((program) => program.member_entity).flatMap(memberCountSlotNames));
    expect([...names].sort()).toEqual(["fns_unit_size", "household_size"]);
  });

  it("sets every count input from the list, building the request the count fact builds", () => {
    fc.assert(fc.property(fc.constantFrom(...withCount.map((program) => program.slug)), fc.integer({ min: 1, max: 8 }), (slug, size) => {
      const program = getProgram(slug)!;
      const viaMembers = buildRequest({ program, period: "2026-01", members: blank(size) });
      const viaFact = buildRequest({ program, period: "2026-01", facts: countFacts(program, size) });
      expect(isDeepStrictEqual(viaMembers.request, viaFact.request)).toBe(true);
      expect(viaMembers.applied.facts_applied).toEqual(countFacts(program, size));
      for (const name of memberCountSlotNames(program)) {
        expect(viaMembers.applied.notes).toContain(
          `set ${name}=${size} from members[]: ${slug} has no member entity, so members[] sets only the household count`
        );
      }
    }), { seed: 20261019, numRuns: 60 });
  });

  it("accepts a count fact equal to the list without a note", () => {
    const program = getProgram("us-ny-tanf")!;
    const built = buildRequest({ program, period: "2026-01", facts: countFacts(program, 3), members: blank(3) });
    expect(built.applied.facts_applied).toEqual({ family_size: 3, number_of_persons_in_household: 3 });
    expect(built.applied.notes.some((note) => note.includes("from members[]"))).toBe(false);
  });

  it("fills only the count inputs the caller left unset", () => {
    const program = getProgram("us-ny-tanf")!;
    const built = buildRequest({ program, period: "2026-01", facts: { family_size: 3 }, members: blank(3) });
    expect(built.applied.facts_applied).toEqual({ family_size: 3, number_of_persons_in_household: 3 });
  });

  it("refuses a count fact that differs from the list, naming both sizes", () => {
    const err = refusal({ program: getProgram("us-ny-tanf")!, period: "2026-01", facts: { family_size: 4 }, members: blank(3) });
    expect(err).toMatchObject({
      kind: "no_member_entity",
      memberCount: 3,
      countInputs: ["family_size", "number_of_persons_in_household"],
      conflicts: [{ slot: "family_size", value: 4 }],
    });
    expect(err.message).toBe(
      "members[] lists 3 entries but family_size=4; us-ny-tanf has no member entity, so members[] only sets family_size, number_of_persons_in_household"
    );
  });

  it("refuses the list on every program with no count input to set", () => {
    for (const program of withoutCount) {
      const err = refusal({ program, members: blank(3) });
      expect(err).toMatchObject({ kind: "no_member_entity", memberCount: 3, countInputs: [], conflicts: [] });
      expect(err.message).toContain(`${program.slug} has no member entity and no recognized household-count input`);
    }
  });

  it("treats an empty list as no list", () => {
    for (const program of noMemberPrograms) {
      expect(buildRequest({ program, members: [] }).request).toEqual(buildRequest({ program }).request);
    }
  });
});

describe.skipIf(!hasEngine)("real-engine members[] with no member entity", () => {
  it("a three-member list reaches the engine as NY TANF's household size", async () => {
    const program = getProgram("us-ny-tanf")!;
    const value = async (options: BuildOptions) =>
      (await computeProgram(options)).outputs.find((o) => o.name === "ny_tanf")!.value as number;
    // The default count is one person; family_size alone does not move the grant.
    expect(await value({ program, period: "2026-01" })).toBeCloseTo(183.1, 2);
    expect(await value({ program, period: "2026-01", facts: { family_size: 3 } })).toBeCloseTo(183.1, 2);
    expect(await value({ program, period: "2026-01", members: blank(3) })).toBe(389);
    expect(await value({ program, period: "2026-01", facts: countFacts(program, 3) })).toBe(389);
  }, 60_000);

  it("a three-member list reaches the engine as the GA and KS assistance-unit count", async () => {
    // The oracle households ga-tanf-family3 (PE 12 x $280) and ks-tanf-family3 (PE $386).
    const cases: Array<{ slug: string; output: string; oneMember: number; threeMembers: number; facts: Facts }> = [
      {
        slug: "us-ga-tanf", output: "ga_tanf_annual_benefit", oneMember: 1860, threeMembers: 3360,
        facts: { household_has_minor_or_pregnant_member: true, determination_is_at_application: true },
      },
      {
        slug: "us-ks-tanf", output: "ks_tanf_prorated_cash_benefit", oneMember: 224, threeMembers: 386,
        facts: { all_persons_in_home_in_same_assistance_plan: true, shelter_group_i_applies: true, days_in_month: 31, application_day_of_month: 1 },
      },
    ];
    for (const { slug, output, oneMember, threeMembers, facts } of cases) {
      const program = getProgram(slug)!;
      const value = async (options: BuildOptions) =>
        (await computeProgram(options)).outputs.find((o) => o.name === output)!.value as number;
      expect(await value({ program, period: "2026-01", facts })).toBe(oneMember);
      expect(await value({ program, period: "2026-01", facts, members: blank(3) })).toBe(threeMembers);
      expect(await value({ program, period: "2026-01", facts: { ...facts, ...countFacts(program, 3) } })).toBe(threeMembers);
    }
  }, 60_000);

  it("a list with no count input to set is refused before the engine runs", async () => {
    // us-in-tanf has assistance_group_size, but its grant is indexed by
    // participating_members, so the list would compute the one-person grant.
    await expect(computeProgram({ program: getProgram("us-in-tanf")!, members: blank(3) })).rejects.toBeInstanceOf(
      NoMemberEntityError
    );
  });
});

describe.skipIf(!hasEngine)("real-engine equivalent household representations", () => {
  it("returns the same indigence judgment with an omitted monetary guideline", async () => {
    const program = getProgram("us-ny-snap")!;
    const options = {
      program, period: "2026-09", outputsOverride: [INDIGENCE_OUTPUT],
      facts: {
        household_size: 1, member_age: 35,
        eligible_sponsored_alien_household_own_monthly_income: 1,
        monthly_cash_contributions_from_sponsor_and_others: 0,
        monthly_value_of_in_kind_assistance_from_sponsor_and_others: 0,
      },
    };
    const synthesized = buildRequest(options);
    const explicit = buildRequest({ ...options, members: [{ facts: { member_age: 35 } }] });
    const synthesizedResult = shapeResult(program, synthesized, await runCompiled(program.slug, synthesized.request));
    const explicitResult = shapeResult(program, explicit, await runCompiled(program.slug, explicit.request));
    expect(explicitResult.outputs).toEqual(synthesizedResult.outputs);
    expect(explicit.request).toEqual(synthesized.request);
    expect(explicitResult.outputs[0].value).toBe("not_holds");
  }, 60_000);
});
