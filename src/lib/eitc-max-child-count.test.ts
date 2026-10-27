import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import { buildRequest, computeProgram, type Facts, type MemberSpec } from "./request-builder";
import { tools } from "./tools";
import { engineAvailable, memberCheck, numericOutput } from "../../scripts/snap-scenarios";

// Asked "What's the maximum earned income tax credit for a family with two
// children in tax year 2026?", gpt-6-luna headlined $664 on 2026-10-25.
// That is the 2026 maximum with no qualifying child; with two it is $7,316
// (IRS Rev. Proc. 2025-32). eitc_maximum reads eitc_child_count, which
// counts the members whose eitc_qualifying_child holds, and 26 USC
// 32(c)(3)(D) makes that gate read qualifying_child_name_age_and_tin_included_on_return.
// The model sent three calls. Its first lookup gave the children an age
// only, and its second lookup and its compute set every other
// qualifying-child fact plus the CTC's lookalike SSN slots. All three counted
// no child, and the lookups said nothing about it: lookup_value ran no
// member checks. The app now assumes the child's TIN is on the return
// (disclosed, like the senior-deduction SSN), and a lookup with a members
// list shows the gates its value counts members through.
const fiit = getProgram("us-fiit")!;
const TIN = "qualifying_child_name_age_and_tin_included_on_return";
const GATE = "eitc_qualifying_child";
const context = { toolCallId: "eitc-max-child-count-test", messages: [] };
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

// The three calls as the model sent them (probe-eitc-max, 1-axiom.json).
const probeChild: MemberSpec = {
  facts: {
    age: 10,
    individual_age_at_close_of_calendar_year: 10,
    individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
    individual_is_younger_than_taxpayer: true,
    individual_principal_place_of_abode_with_taxpayer_fraction: 1,
    qualifying_child_principal_place_of_abode_is_in_united_states: true,
    qualifying_child_ssn_included_on_return: true,
    qualifying_child_ssn_is_valid_for_subsection_h: true,
  },
};
const LOOKUP_AGE_ONLY = {
  program: "us-fiit",
  output: "eitc_maximum",
  period: "2026",
  facts: { filing_status: 3 },
  members: [{ facts: { is_taxpayer: true } }, { facts: { age: 10 } }, { facts: { age: 10 } }] as MemberSpec[],
};
const LOOKUP_FULL = {
  program: "us-fiit",
  output: "eitc_maximum",
  period: "2026",
  facts: { filing_status: 3 },
  members: [
    {
      facts: {
        is_taxpayer: true,
        taxpayer_or_spouse_ssn_included_on_return: true,
        taxpayer_or_spouse_ssn_is_valid_for_subsection_h: true,
        age: 40,
        individual_age_at_close_of_calendar_year: 40,
      },
    },
    probeChild,
    probeChild,
  ],
};
const COMPUTE = {
  program: "us-fiit",
  period: "2026",
  facts: { filing_status: 3, taxpayer_is_individual: true },
  members: [
    { facts: { is_taxpayer: true, age: 40, individual_age_at_close_of_calendar_year: 40, individual_is_younger_than_taxpayer: false } },
    probeChild,
    probeChild,
  ],
  extra_outputs: ["eitc_maximum", "eitc_maximum_amount"],
};

/** 2026 maximum credit by qualifying children, three or more capped at
 *  three (IRS Rev. Proc. 2025-32). */
const MAXIMUM = [664, 4427, 7316, 8231];
const maximumFor = (children: number) => MAXIMUM[Math.min(children, 3)];

const taxpayer: MemberSpec = { facts: { is_taxpayer: true, age: 40, individual_age_at_close_of_calendar_year: 40 } };
/** A child who meets every eitc_qualifying_child test except, maybe, the TIN. */
const child = (tin?: boolean): MemberSpec => ({
  facts: {
    ...probeChild.facts,
    ...(tin !== undefined && { [TIN]: tin }),
  },
});
const tinRecords = (built: ReturnType<typeof buildRequest>, entityId: string) =>
  built.request.dataset.inputs.filter((i) => i.name.endsWith(`#input.${TIN}`) && i.entity_id === entityId);

describe("the child-TIN assumption", () => {
  it("is read only by the EITC rules", () => {
    const slot = fiit.inputs.Person.find((s) => s.name === TIN)!;
    expect(slot.read_by).toEqual(expect.arrayContaining(["eitc", "eitc_child_count", "eitc_maximum", GATE]));
    expect(slot.read_by!.every((rule) => rule.startsWith("eitc"))).toBe(true);
  });

  it("sets the TIN on every member with no SSN or TIN fact stated false", () => {
    const built = buildRequest({ program: fiit, period: "2026", facts: COMPUTE.facts, members: COMPUTE.members });
    for (const id of ["person:1", "person:2", "person:3"]) {
      expect(tinRecords(built, id).every((i) => i.value.value === true)).toBe(true);
    }
    // Before the compute every assumed member is listed; shapeResult narrows it.
    expect(built.applied.assumed_facts).toContainEqual(expect.objectContaining({ slot: TIN, value: true, members: [1, 2, 3] }));
  });

  it("keeps a stated TIN, and an SSN fact stated false turns it off for that member", () => {
    const stated = buildRequest({ program: fiit, period: "2026", members: [taxpayer, child(false), child()] });
    expect(tinRecords(stated, "person:2").every((i) => i.value.value === false)).toBe(true);
    expect(tinRecords(stated, "person:3").every((i) => i.value.value === true)).toBe(true);

    const noSsn: MemberSpec = { facts: { ...probeChild.facts, qualifying_child_ssn_included_on_return: false } };
    const built = buildRequest({ program: fiit, period: "2026", members: [taxpayer, noSsn, child()] });
    expect(tinRecords(built, "person:2").every((i) => i.value.value === false)).toBe(true);
    expect(built.applied.assumed_facts?.find((a) => a.slot === TIN)?.members).toEqual([1, 3]);
  });

  it("stays out of lookups that don't read it and programs other than us-fiit", () => {
    const lookup = buildRequest({ program: fiit, period: "2026", outputsOverride: ["exemption_amount"] });
    expect(lookup.applied.assumed_facts).toBeUndefined();
    const snap = buildRequest({ program: getProgram("us-fl-snap")!, facts: { household_size: 2 } });
    expect(snap.applied.assumed_facts?.map((a) => a.slot)).toEqual(["member_is_us_citizen"]);
  });
});

describe("member checks on the lookup path", () => {
  it("leaves the lookup's own request as it was, and checks only the named gates at every listed member", () => {
    const options = { program: fiit, period: "2026", members: LOOKUP_AGE_ONLY.members, outputsOverride: ["eitc_maximum"] };
    // The first run is the plain lookup; member checks are a second run.
    expect(buildRequest(options).memberCheckIds).toEqual([]);

    const checked = buildRequest({ ...options, memberChecks: [GATE] });
    expect(checked.memberChecksScope).toBe("counted");
    expect(checked.memberCheckIds).toEqual(["person:1", "person:2", "person:3"]);
    expect([...checked.memberCheckNames]).toEqual([GATE]);

    const bare = buildRequest({ program: fiit, period: "2026", outputsOverride: ["eitc_maximum"], memberChecks: [GATE] });
    expect(bare.memberCheckIds).toEqual([]);
  });
});

describe.skipIf(!hasEngine)("real-engine 2026 EITC maximum with two children", () => {
  it("answers the model's second lookup with $7,316 and discloses the TIN for the children only", async () => {
    const result = (await tools.lookup_value.execute!(LOOKUP_FULL, context)) as Record<string, any>;
    expect(result.value).toBe(7316);
    expect(result.member_checks).toEqual([
      { member: 1, checks: [expect.objectContaining({ name: GATE, value: "not_holds" })] },
      { member: 2, checks: [expect.objectContaining({ name: GATE, value: "holds" })] },
      { member: 3, same_as: 2 },
    ]);
    expect(result.applied.assumed_facts).toEqual([expect.objectContaining({ slot: TIN, members: [2, 3] })]);
    expect(result.applied.notes.some((n: string) => n.startsWith("WARNING"))).toBe(false);
  }, 30_000);

  it("answers the model's compute with $7,316", async () => {
    const result = (await tools.compute.execute!(COMPUTE, context)) as Record<string, any>;
    expect(result.outputs.find((o: { name: string }) => o.name === "eitc_maximum").value).toBe(7316);
    expect(result.applied.assumed_facts).toContainEqual(expect.objectContaining({ slot: TIN, members: [2, 3] }));
  }, 30_000);

  it("shows why the age-only lookup counted no child", async () => {
    const result = (await tools.lookup_value.execute!(LOOKUP_AGE_ONLY, context)) as Record<string, any>;
    // The children lack relationship, residence and the age-test facts, so
    // $664 stands, but the result now says so and names what to set.
    expect(result.value).toBe(664);
    const childCheck = result.member_checks.find((m: { member: number }) => m.member === 2);
    const check = childCheck.checks ?? result.member_checks.find((m: { member: number }) => m.member === childCheck.same_as).checks;
    expect(check).toEqual([
      expect.objectContaining({
        name: GATE,
        value: "not_holds",
        requires: expect.arrayContaining([
          expect.objectContaining({ slot: "individual_principal_place_of_abode_with_taxpayer_fraction" }),
        ]),
        requires_any: expect.arrayContaining([expect.objectContaining({ rule: "qualifying_child_relationship" })]),
      }),
    ]);
    expect(result.applied.notes).toContainEqual(expect.stringMatching(/^WARNING: eitc_maximum counts members through eitc_qualifying_child, which holds for none of the 3 listed members/));
  }, 30_000);

  it("gives the childless maximum to a filer alone, with no warning and no TIN disclosure", async () => {
    const result = (await tools.lookup_value.execute!(
      { program: "us-fiit", output: "eitc_maximum", period: "2026", members: [taxpayer] },
      context
    )) as Record<string, any>;
    expect(result.value).toBe(664);
    expect(result.applied.assumed_facts).toBeUndefined();
    expect(result.applied.notes.some((n: string) => n.startsWith("WARNING"))).toBe(false);
  }, 30_000);

  it("leaves lookup member checks off an output that counts no member", async () => {
    const result = (await tools.lookup_value.execute!(
      { program: "us-fiit", output: "exemption_amount", period: "2026", members: [taxpayer, child()] },
      context
    )) as Record<string, any>;
    expect(result.value).toBe(0);
    expect(result.member_checks).toBeUndefined();
  }, 30_000);

  // Invariants, for any number of children (0–5) each with the TIN unstated,
  // stated true or stated false:
  //  - the maximum is the Rev. Proc. 2025-32 amount for the children whose
  //    TIN isn't stated false (three or more capped at three);
  //  - the TIN assumption is disclosed for exactly the unstated children;
  //  - lookup_value and compute's extra_outputs agree on the value and on
  //    every member's eitc_qualifying_child (two paths, one semantics).
  it("matches the maximum table for any mix of stated and unstated child TINs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom<boolean | undefined>(undefined, true, false), { maxLength: 5 }), async (tins) => {
        const members = [taxpayer, ...tins.map(child)];
        const options = { program: fiit, period: "2026", facts: { filing_status: 3 } as Facts, members };
        const lookup = await computeProgram({ ...options, outputsOverride: ["eitc_maximum"] });
        const compute = await computeProgram({ ...options, extraOutputs: ["eitc_maximum"] });
        const counted = tins.filter((tin) => tin !== false).length;
        expect(numericOutput(lookup, "eitc_maximum")).toBe(maximumFor(counted));
        expect(numericOutput(compute, "eitc_maximum")).toBe(maximumFor(counted));
        const unstated = tins.flatMap((tin, i) => (tin === undefined ? [i + 2] : []));
        const disclosed = (r: typeof lookup) => r.applied.assumed_facts?.find((a) => a.slot === TIN)?.members ?? [];
        expect(disclosed(lookup)).toEqual(unstated);
        expect(disclosed(compute)).toEqual(unstated);
        members.forEach((_, i) => {
          expect(memberCheck(lookup, i + 1, GATE).value).toBe(memberCheck(compute, i + 1, GATE).value);
        });
      }),
      { seed: 20261026, numRuns: 20 }
    );
  }, 120_000);
});
