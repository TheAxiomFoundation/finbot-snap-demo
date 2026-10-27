import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { getCatalog, getProgram } from "./catalog";
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
// list shows the gates its value counts members through, with a warning
// where a count of members left out a listed member it plausibly meant.
const fiit = getProgram("us-fiit")!;
const TIN = "qualifying_child_name_age_and_tin_included_on_return";
const GATE = "eitc_qualifying_child";
const EITC_RELATION = "us:statutes/26/32#relation.qualifying_child_of_tax_unit";
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
const spouse: MemberSpec = { facts: { is_spouse_of_taxpayer: true, age: 40, individual_age_at_close_of_calendar_year: 40 } };
type Relationship = "stated" | "unstated" | "denied";
/** A child who meets every eitc_qualifying_child test except, maybe, the TIN
 *  and the relationship (unstated, or denied: neither the taxpayer's child
 *  nor a sibling); or, `ageOnly`, a child described by age alone (the
 *  probe's first lookup). */
const child = (tin?: boolean, ageOnly = false, relationship: Relationship = "stated"): MemberSpec => {
  const { individual_is_child_of_taxpayer_or_descendant_of_such_child: _, ...rest } = probeChild.facts!;
  const full =
    relationship === "stated"
      ? probeChild.facts
      : relationship === "unstated"
        ? rest
        : {
            ...rest,
            individual_is_child_of_taxpayer_or_descendant_of_such_child: false,
            individual_is_sibling_stepsibling_or_descendant_of_such_relative: false,
          };
  return {
    facts: {
      ...(ageOnly ? { age: 10, individual_age_at_close_of_calendar_year: 10 } : full),
      ...(tin !== undefined && { [TIN]: tin }),
    },
  };
};
/** A child who also meets the CTC's tests. */
const ctcChild: MemberSpec = {
  facts: {
    ...probeChild.facts,
    ctc_child_satisfies_subsection_c: true,
    ctc_child_satisfies_dependency_rules: true,
    ctc_child_deduction_allowed: true,
  },
};
const isMemberCountWarning = (note: string) => note.startsWith("WARNING: member") || / counts? members through /.test(note);
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

  it("stays off a member whose name or TIN is stated missing from the return", () => {
    // The aux component slots feed no rule, so before this a child stated
    // with no name on the return still got the aggregate slot assumed true.
    const statements: Facts[] = [
      { qualifying_child_name_included_on_return: false },
      { qualifying_child_tin_included_on_return: false },
      { qualifying_child_tin_issued_on_or_before_return_due_date: false },
      { ctc_child_missing_identification: true },
    ];
    for (const missing of statements) {
      const stated: MemberSpec = { facts: { ...probeChild.facts, ...missing } };
      const built = buildRequest({ program: fiit, period: "2026", members: [taxpayer, stated, child()] });
      expect(tinRecords(built, "person:2").every((i) => i.value.value === false)).toBe(true);
      expect(built.applied.assumed_facts?.find((a) => a.slot === TIN)?.members).toEqual([1, 3]);
    }
    const topLevel = buildRequest({
      program: fiit,
      period: "2026",
      facts: { qualifying_child_name_included_on_return: false },
      members: [taxpayer, child(), child()],
    });
    expect(topLevel.applied.assumed_facts?.find((a) => a.slot === TIN)).toBeUndefined();
  });

  // Review r3: a shared child-SSN fact stated false at the top level kept
  // the assumption off for every child, even one whose own facts said its
  // SSN is on the return (maximum $664 instead of $4,427).
  it("follows a member's own identification facts over the top level's", () => {
    const { qualifying_child_ssn_included_on_return: _, ...silent } = probeChild.facts!;
    const included: MemberSpec = { facts: { ...silent, qualifying_child_ssn_included_on_return: true } };
    const shared: Facts[] = [
      { qualifying_child_ssn_included_on_return: false },
      { ctc_child_missing_identification: true },
    ];
    for (const facts of shared) {
      const own: MemberSpec = Object.keys(facts).includes("ctc_child_missing_identification")
        ? { facts: { ...silent, ctc_child_missing_identification: false } }
        : included;
      // Member 3 says nothing of its own, so the top level's fact holds.
      const built = buildRequest({ program: fiit, period: "2026", facts, members: [taxpayer, own, { facts: silent }] });
      expect(tinRecords(built, "person:2").every((i) => i.value.value === true)).toBe(true);
      expect(tinRecords(built, "person:3").every((i) => i.value.value === false)).toBe(true);
      expect(built.applied.assumed_facts?.find((a) => a.slot === TIN)?.members).toEqual([2]);
    }
  });

  // Review r3: a child whose SSN was stated missing was told it failed the
  // EITC gate "only on facts no one stated" and to set the TIN. A fact that
  // keeps an assumption off speaks to its slot, so the slot counts as stated.
  it("counts an assumption's slot as stated where the member's facts kept it off", () => {
    const noSsn: MemberSpec = { facts: { ...probeChild.facts, qualifying_child_ssn_included_on_return: false } };
    const built = buildRequest({ program: fiit, period: "2026", members: [taxpayer, noSsn, child()] });
    expect(built.memberLinks[1].stated).toContain(TIN);
    expect(tinRecords(built, "person:2").every((i) => i.value.value === false)).toBe(true);
    // Assumed slots count as stated too: they were set.
    expect(built.memberLinks[2].stated).toContain(TIN);
  });

  it("ignores the parents' own SSN facts", () => {
    // Review r2: a top-level taxpayer SSN fact set false turned the child's
    // TIN off for every child, undisclosed (maximum $664 instead of $7,316).
    const parentFacts: Facts[] = [
      { taxpayer_or_spouse_ssn_included_on_return: false },
      { taxpayer_or_spouse_ssn_is_valid_for_subsection_h: false },
      { qualified_individual_social_security_number_included_on_return: false },
    ];
    for (const facts of parentFacts) {
      const built = buildRequest({ program: fiit, period: "2026", facts, members: [taxpayer, child(), child()] });
      for (const id of ["person:2", "person:3"]) {
        expect(tinRecords(built, id).every((i) => i.value.value === true)).toBe(true);
      }
      expect(built.applied.assumed_facts?.find((a) => a.slot === TIN)?.members).toEqual([1, 2, 3]);
    }
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

  it("records each member's relations, filer role and stated facts", () => {
    const built = buildRequest({
      program: fiit,
      period: "2026",
      facts: { taxpayer_or_spouse_ssn_included_on_return: true },
      members: [taxpayer, { ...child(), relations: ["dependent_of_tax_unit"] }],
    });
    expect(built.memberLinks[0]).toEqual({
      relations: expect.arrayContaining([EITC_RELATION]),
      filer: true,
      stated: expect.arrayContaining(["is_taxpayer", "age", "taxpayer_or_spouse_ssn_included_on_return", TIN]),
    });
    expect(built.memberLinks[1]).toEqual({
      relations: ["us:statutes/26/24/h#relation.dependent_of_tax_unit"],
      filer: false,
      stated: expect.arrayContaining([...Object.keys(probeChild.facts!), "taxpayer_or_spouse_ssn_included_on_return", TIN]),
    });
    expect(built.memberLinks[1].stated).not.toContain("individual_is_disabled");
    const snap = buildRequest({ program: getProgram("us-az-snap")!, period: "2026-01", members: [{}, {}] });
    expect(snap.memberLinks.map((links) => links.filer)).toEqual([null, null]);
  });
});

// The catalog records, per relation, the rules that count members over it
// through gates, which gates each reads exclusionary, and which it counts as
// a number of members. A lookup's gate walk follows those edges (review r1: a
// member rule reading a gate directly raised a false warning), and only a
// quantity can warn that it counted no one (review r2: `count > 0` tests in
// SNAP and the CTC's other-dependent count warned on correct answers).
describe("relation aggregations in the catalog", () => {
  const relation = (slug: string, name: string) =>
    getProgram(slug)!.relations.find((r) => r.name === name)!;
  const aggregation = (slug: string, rule: string) =>
    getProgram(slug)!.relations.flatMap((r) => r.aggregations ?? []).find((a) => a.rule === rule)!;
  const memberPrograms = ["us-fiit", ...["al", "az", "ca", "co", "fl", "ga", "ma", "nc", "ny", "sc", "tn"].map((s) => `us-${s}-snap`)];

  it("lists eitc_child_count as counting eitc_qualifying_child as a number, positively", () => {
    expect(relation("us-fiit", EITC_RELATION).gate_judgments).toEqual([GATE]);
    expect(relation("us-fiit", EITC_RELATION).aggregations).toEqual([
      { rule: "eitc_child_count", gates: [GATE], quantity_gates: [GATE], quantity_readers: expect.any(Array) },
    ]);
  });

  // Review r3: eitc_demographic_eligible only tests `eitc_child_count > 0`,
  // yet warned for a single filer and a listed parent because another output
  // reads the count as a number. eitc_maximum reads it through
  // eitc_capped_child_count, picking its amount by `== 0`, `== 1`, `== 2`.
  it("records which outputs read eitc_child_count as a number", () => {
    const readers = aggregation("us-fiit", "eitc_child_count").quantity_readers!;
    expect(readers).toEqual(
      expect.arrayContaining(["eitc", "eitc_capped_child_count", "eitc_maximum", "eitc_phase_in_rate", "eitc_phase_out_start"])
    );
    expect(readers).not.toContain("eitc_child_count");
    expect(readers).not.toContain("eitc_demographic_eligible");
    expect(readers).not.toContain(GATE);
    expect(aggregation("us-fiit", "ctc_qualifying_children_under_subsection_h").quantity_readers).toContain(
      "ctc_maximum_before_phaseout"
    );
  });

  it("marks the gates SNAP rules test for zero as exclusionary, per rule", () => {
    // snap_ssn_eligible: count(where: snap_member_ssn_requirement_ineligible) == 0.
    expect(aggregation("us-az-snap", "snap_ssn_eligible").exclusionary_gates).toEqual(["snap_member_ssn_requirement_ineligible"]);
    // snap_household_member_eligible: count(where: snap_member_eligible) > 0.
    expect(aggregation("us-az-snap", "snap_household_member_eligible").exclusionary_gates).toBeUndefined();
    // household_has_no_earned_income_at_certification: count(...) == 0.
    expect(aggregation("us-co-snap", "household_has_no_earned_income_at_certification").exclusionary_gates).toEqual([
      "payment_considered_earned_income",
    ]);
  });

  it("counts members as a number only in the six us-fiit rules that multiply, subtract or are the count", () => {
    const quantities = memberPrograms.flatMap((slug) =>
      getProgram(slug)!.relations.flatMap((r) => (r.aggregations ?? []).filter((a) => a.quantity_gates).map((a) => `${slug} ${a.rule}`))
    );
    expect(quantities.sort()).toEqual(
      [
        "ctc_other_dependents_under_subsection_h",
        "ctc_qualifying_children_count",
        "ctc_qualifying_children_under_subsection_h",
        "eitc_child_count",
        "section_151_exemption_deduction",
        "senior_deduction",
      ].map((rule) => `us-fiit ${rule}`)
    );
  });

  it("keeps each aggregation's marked gates among the gates it reads, and those among the relation's", () => {
    for (const program of memberPrograms.map((slug) => getProgram(slug)!)) {
      for (const r of program.relations) {
        for (const a of r.aggregations ?? []) {
          expect(a.gates.length).toBeGreaterThan(0);
          for (const gate of a.gates) expect(r.gate_judgments).toContain(gate);
          for (const gate of [...(a.exclusionary_gates ?? []), ...(a.quantity_gates ?? [])]) expect(a.gates).toContain(gate);
          // Readers come with quantity gates only, and are scalar rules of
          // the same program: a judgment holds or not, never a number.
          expect(a.quantity_readers !== undefined).toBe(a.quantity_gates !== undefined);
          for (const reader of a.quantity_readers ?? []) {
            expect(reader).not.toBe(a.rule);
            const output = program.outputs.find((o) => o.name === reader);
            if (output) expect(output.semantics).not.toBe("judgment");
          }
        }
      }
    }
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
    // The taxpayer is a filer, so only the children were plausibly meant.
    expect(result.applied.notes).toContainEqual(
      expect.stringMatching(/^WARNING: eitc_maximum counts members through eitc_qualifying_child, which holds for none of the 3 listed members linked through qualifying_child_of_tax_unit, so none of them counted through it\. Members 2, 3 fail it only on facts no one stated: .* look the value up again once; otherwise this value stands\.$/)
    );
  }, 30_000);

  it("names a lone child who fails only on facts no one stated", async () => {
    // Review r2: with one listed member the warning stayed off.
    const result = await computeProgram({
      program: fiit,
      period: "2026",
      facts: { filing_status: 3 },
      members: [{ facts: { age: 10 } }],
      outputsOverride: ["eitc_maximum"],
    });
    expect(numericOutput(result, "eitc_maximum")).toBe(664);
    expect(result.applied.notes).toContainEqual(expect.stringMatching(/, which doesn't hold for the one listed member linked through qualifying_child_of_tax_unit, so that member didn't count through it\. Member 1 fails it only on facts no one stated: /));
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

  it("counts no child whose name is stated missing from the return", async () => {
    const noName = (): MemberSpec => ({ facts: { ...probeChild.facts, qualifying_child_name_included_on_return: false } });
    const lookup = (members: MemberSpec[]) =>
      computeProgram({ program: fiit, period: "2026", facts: { filing_status: 3 }, members, outputsOverride: ["eitc_maximum"] });
    expect(numericOutput(await lookup([taxpayer, noName(), child()]), "eitc_maximum")).toBe(4427);
    const neither = await lookup([taxpayer, noName(), noName()]);
    expect(numericOutput(neither, "eitc_maximum")).toBe(664);
    expect(neither.applied.assumed_facts).toBeUndefined();
  }, 30_000);

  it("names a child who qualifies but isn't linked through the EITC relation, on lookups and computes", async () => {
    const members = [taxpayer, { ...child(), relations: ["dependent_of_tax_unit"] }];
    const options = { program: fiit, period: "2026", facts: { filing_status: 3 } as Facts, members };
    const lookup = await computeProgram({ ...options, outputsOverride: ["eitc_maximum"] });
    expect(numericOutput(lookup, "eitc_maximum")).toBe(664);
    expect(memberCheck(lookup, 2, GATE).value).toBe("holds");
    expect(lookup.applied.notes).toContainEqual(
      expect.stringMatching(/^WARNING: member 2 holds eitc_qualifying_child but isn't linked through qualifying_child_of_tax_unit, .* look the value up again once\.$/)
    );
    const compute = await computeProgram({ ...options, extraOutputs: ["eitc_maximum"] });
    expect(numericOutput(compute, "eitc_maximum")).toBe(664);
    expect(compute.applied.notes).toContainEqual(
      expect.stringMatching(/^WARNING: member 2 holds eitc_qualifying_child but isn't linked through qualifying_child_of_tax_unit, .* compute again once\.$/)
    );
    // Linked through every relation, the same child counts and nothing warns.
    const linked = await computeProgram({ ...options, members: [taxpayer, child()], outputsOverride: ["eitc_maximum"] });
    expect(numericOutput(linked, "eitc_maximum")).toBe(4427);
    expect(linked.applied.notes.some((n) => n.startsWith("WARNING: member"))).toBe(false);
  }, 60_000);

  it("doesn't warn a childless couple filing jointly", async () => {
    for (const output of ["eitc_maximum", "senior_deduction"]) {
      const result = await computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 1 },
        members: [taxpayer, spouse],
        outputsOverride: [output],
      });
      expect(result.member_checks?.length).toBeGreaterThan(0);
      expect(result.applied.notes.some((n) => n.startsWith("WARNING"))).toBe(false);
    }
  }, 60_000);

  // Review r2: correct lookups warned that no member counted. The CTC's
  // maximum counted two qualifying children but warned through the
  // other-dependent gate; the senior deduction warned for a couple of 40 with
  // two children.
  it("doesn't warn a family whose children count, or on the senior deduction of a couple under 65", async () => {
    const family = {
      program: fiit,
      period: "2026",
      facts: { filing_status: 1, taxpayer_or_spouse_ssn_included_on_return: true, taxpayer_or_spouse_ssn_is_valid_for_subsection_h: true } as Facts,
      members: [taxpayer, spouse, ctcChild, ctcChild],
    };
    const ctc = await computeProgram({ ...family, outputsOverride: ["ctc_maximum_before_phaseout"] });
    expect(numericOutput(ctc, "ctc_maximum_before_phaseout")).toBe(4400);
    expect(memberCheck(ctc, 3, "ctc_other_dependent_under_subsection_h").value).toBe("not_holds");
    expect(ctc.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    // Everyone fails senior_deduction_qualified_individual on a stated age;
    // the children also fail its filer-role alternatives.
    const senior = await computeProgram({ ...family, outputsOverride: ["senior_deduction"] });
    expect(numericOutput(senior, "senior_deduction")).toBe(0);
    expect(senior.applied.notes.filter(isMemberCountWarning)).toEqual([]);
  }, 60_000);

  // Every us-fiit output looked up for a family whose facts are complete.
  // section_151_exemption_deduction warned until review r4: its gate lists
  // only tin_included_on_return_claiming_exemption, which nobody states, but
  // the children fail it on a test the list leaves out (`requires_partial`),
  // so with the TIN set they still fail it and the check that confirms a
  // warning drops it.
  it("gives a fully described family no member-count warning on any us-fiit lookup", async () => {
    const warned: string[] = [];
    for (const output of fiit.outputs) {
      const result = await computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 1, taxpayer_or_spouse_ssn_included_on_return: true, taxpayer_or_spouse_ssn_is_valid_for_subsection_h: true },
        members: [taxpayer, spouse, ctcChild, ctcChild],
        outputsOverride: [output.name],
      });
      if (result.applied.notes.some(isMemberCountWarning)) warned.push(output.name);
    }
    expect(warned).toEqual([]);
  }, 180_000);

  // SNAP reads its counts of members only as tests (`count > 0`, `== 0`,
  // all-of), so its lookups never warn that a count counted no one: in
  // review r2, CA's snap_benefit warned through its drug-felony exclusion,
  // and NY's and GA's through categorical TANF/SSI gates most households
  // don't hold.
  it("never warns that a SNAP count counted no listed member", async () => {
    for (const program of getCatalog().programs.filter((p) => /-snap$/.test(p.slug) && p.member_entity)) {
      const earned = Object.values(program.inputs).flat().some((slot) => slot.name === "snap_gross_monthly_earned_income");
      for (const output of program.outputs.filter((o) => o.certified)) {
        const result = await computeProgram({
          program,
          facts: earned ? { snap_gross_monthly_earned_income: 1500 } : {},
          members: [{ facts: { member_age: 35 } }, { facts: { member_age: 33 } }, { facts: { member_age: 8 } }],
          outputsOverride: [output.name],
        });
        expect([program.slug, output.name, result.applied.notes.filter(isMemberCountWarning)]).toEqual([program.slug, output.name, []]);
      }
    }
  }, 120_000);

  it("doesn't warn on AZ SNAP member rules or exclusionary gates", async () => {
    const az = getProgram("us-az-snap")!;
    const lookup = (output: string) =>
      computeProgram({ program: az, period: "2026-01", members: [{}, {}], outputsOverride: [output] });
    // A member rule reads its gate directly: no count, so no member checks.
    const member = await lookup("snap_member_ssn_requirement_eligible");
    expect(member.member_checks).toBeUndefined();
    expect(member.applied.notes.some((n) => n.startsWith("WARNING"))).toBe(false);
    // count(where: snap_member_ssn_requirement_ineligible) == 0: no member
    // holding it is what makes the household pass.
    const household = await lookup("snap_ssn_eligible");
    expect(household.outputs[0].value).toBe("holds");
    expect(memberCheck(household, 1, "snap_member_ssn_requirement_ineligible").value).toBe("not_holds");
    expect(household.applied.notes.some((n) => n.startsWith("WARNING"))).toBe(false);
  }, 60_000);

  it("leaves lookup member checks off an output that counts no member", async () => {
    const result = (await tools.lookup_value.execute!(
      { program: "us-fiit", output: "exemption_amount", period: "2026", members: [taxpayer, child()] },
      context
    )) as Record<string, any>;
    expect(result.value).toBe(0);
    expect(result.member_checks).toBeUndefined();
  }, 30_000);

  // Review r3, finding 1: two children who fail
  // ctc_qualifying_child_under_subsection_h because the parents' SSN facts
  // sat on the taxpayer's record only still count as other dependents, so
  // the maximum came out $1,000 instead of $4,400, with no warning: some
  // gate of the output had counted someone.
  it("names children demoted to other dependents on facts no one stated on them", async () => {
    const parentSsn = { taxpayer_or_spouse_ssn_included_on_return: true, taxpayer_or_spouse_ssn_is_valid_for_subsection_h: true };
    const lookup = (facts: Facts, first: MemberSpec) =>
      computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 1, ...facts },
        members: [first, spouse, ctcChild, ctcChild],
        outputsOverride: ["ctc_maximum_before_phaseout"],
      });
    const demoted = await lookup({}, { facts: { ...taxpayer.facts, ...parentSsn } });
    expect(numericOutput(demoted, "ctc_maximum_before_phaseout")).toBe(1000);
    expect(memberCheck(demoted, 3, "ctc_other_dependent_under_subsection_h").value).toBe("holds");
    expect(demoted.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(
        /^WARNING: ctc_maximum_before_phaseout counts members through ctc_qualifying_child_under_subsection_h, which holds for none of the 4 listed members linked through dependent_of_tax_unit, so none of them counted through it\. Members 3, 4 fail it only on facts no one stated: /
      ),
    ]);
    const shared = await lookup(parentSsn, taxpayer);
    expect(numericOutput(shared, "ctc_maximum_before_phaseout")).toBe(4400);
    expect(shared.applied.notes.filter(isMemberCountWarning)).toEqual([]);
  }, 60_000);

  // Review r3, finding 2: a child who meets every core test but has no
  // relationship stated fails only a `requires_any` alternative, and went
  // unflagged. A child stated to be neither a child nor a sibling of the
  // taxpayer fails on stated facts and stays quiet, even with its residence
  // left unstated.
  it("weighs the requires_any alternatives a member fails", async () => {
    const { individual_is_child_of_taxpayer_or_descendant_of_such_child: _, ...noRelationship } = probeChild.facts!;
    const lookup = (facts: Facts) =>
      computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 3 },
        members: [taxpayer, { facts }],
        outputsOverride: ["eitc_maximum"],
      });
    const unstated = await lookup(noRelationship);
    expect(numericOutput(unstated, "eitc_maximum")).toBe(664);
    expect(unstated.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(/ so none of them counted through it\. Member 2 fails it only on facts no one stated: /),
    ]);
    const neither = await lookup({
      age: 10,
      individual_age_at_close_of_calendar_year: 10,
      individual_is_younger_than_taxpayer: true,
      individual_is_child_of_taxpayer_or_descendant_of_such_child: false,
      individual_is_sibling_stepsibling_or_descendant_of_such_relative: false,
    });
    expect(numericOutput(neither, "eitc_maximum")).toBe(664);
    expect(neither.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    const tooOld = await lookup({
      age: 30,
      individual_age_at_close_of_calendar_year: 30,
      individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
      individual_is_permanently_and_totally_disabled: false,
    });
    expect(numericOutput(tooOld, "eitc_maximum")).toBe(664);
    expect(tooOld.applied.notes.filter(isMemberCountWarning)).toEqual([]);
  }, 60_000);

  // Review r3, finding 3: a fully described child whose SSN, name or TIN
  // timing is stated missing is rightly left out, and was then told to set
  // the TIN its own facts had ruled out.
  it("doesn't name a child whose identification is stated missing", async () => {
    const statements: Facts[] = [
      { qualifying_child_ssn_included_on_return: false },
      { qualifying_child_name_included_on_return: false },
      { qualifying_child_tin_issued_on_or_before_return_due_date: false },
      { ctc_child_missing_identification: true },
      { [TIN]: false },
    ];
    for (const missing of statements) {
      const result = await computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 3 },
        members: [taxpayer, { facts: { ...probeChild.facts, ...missing } }],
        outputsOverride: ["eitc_maximum"],
      });
      expect([missing, numericOutput(result, "eitc_maximum")]).toEqual([missing, 664]);
      expect([missing, result.applied.notes.filter(isMemberCountWarning)]).toEqual([missing, []]);
    }
  }, 60_000);

  // Review r3, finding 4: eitc_demographic_eligible only tests
  // `eitc_child_count > 0`, and passes for a childless filer, yet warned for
  // a single filer of 40 with a listed parent of 70. eitc_maximum reads the
  // count as a number and still names the parent: the model is told to keep
  // the value unless the user's description puts that member in the count.
  it("warns only on outputs that read the count as a number", async () => {
    const lookup = (output: string) =>
      computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 3 },
        members: [
          { facts: { is_taxpayer: true, age: 40, individual_age_at_close_of_calendar_year: 40 } },
          { facts: { age: 70, individual_age_at_close_of_calendar_year: 70 } },
        ],
        outputsOverride: [output],
      });
    const demographic = await lookup("eitc_demographic_eligible");
    expect(demographic.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    const maximum = await lookup("eitc_maximum");
    expect(numericOutput(maximum, "eitc_maximum")).toBe(664);
    expect(maximum.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(/ Member 2 fails it only on facts no one stated: .* otherwise this value stands\.$/),
    ]);
  }, 60_000);

  // Review r3, finding 6: a taxpayer of 70 described only by
  // individual_age_at_close_of_calendar_year (the senior test reads `age`)
  // lost the $6,000 deduction silently, because filers were never named.
  // The senior gate's requirements name the filer roles, so there they
  // decide: the taxpayer is named, the children fail the roles.
  it("names a filer for the senior deduction, whose gate the filer roles decide", async () => {
    const lookup = (members: MemberSpec[], facts: Facts = { filing_status: 3 }) =>
      computeProgram({ program: fiit, period: "2026", facts, members, outputsOverride: ["senior_deduction"] });
    const ageAtClose = await lookup([{ facts: { is_taxpayer: true, individual_age_at_close_of_calendar_year: 70 } }]);
    expect(numericOutput(ageAtClose, "senior_deduction")).toBe(0);
    expect(ageAtClose.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(/^WARNING: senior_deduction counts members through senior_deduction_qualified_individual, .* Member 1 fails it only on facts no one stated: /),
    ]);
    const stated = await lookup([{ facts: { is_taxpayer: true, age: 70, individual_age_at_close_of_calendar_year: 70 } }]);
    expect(numericOutput(stated, "senior_deduction")).toBe(6000);
    expect(stated.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    // Only the filer is named; a child fails the filer-role alternatives.
    const withKids = await lookup([{ facts: { is_taxpayer: true, individual_age_at_close_of_calendar_year: 70 } }, child(), child()]);
    expect(withKids.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(/ Member 1 fails it only on facts no one stated: /),
    ]);
  }, 60_000);

  // Review r4, finding 1: a joint return's spouse of 70 listed without a
  // role lost the $6,000 deduction silently, because the taxpayer's role
  // made every member's roles count as stated. A return has one taxpayer and
  // at most one spouse, so only the roles some member carries count as
  // stated for the rest.
  it("names an untagged member who would be the spouse on a joint return", async () => {
    const lookup = (members: MemberSpec[], filingStatus: number) =>
      computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: filingStatus },
        members,
        outputsOverride: ["senior_deduction"],
      });
    const untagged = await lookup([taxpayer, { facts: { age: 70, individual_age_at_close_of_calendar_year: 70 } }], 1);
    expect(numericOutput(untagged, "senior_deduction")).toBe(0);
    expect(untagged.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(/ Member 2 fails it only on facts no one stated: .* it holds\. /),
    ]);
    const tagged = await lookup([taxpayer, { facts: { is_spouse_of_taxpayer: true, age: 70, individual_age_at_close_of_calendar_year: 70 } }], 1);
    expect(numericOutput(tagged, "senior_deduction")).toBe(6000);
    expect(tagged.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    // Head of household: the return isn't joint, so a parent of 70 can't be
    // the spouse on it, and the taxpayer's role rules out the other branch.
    const parent = await lookup([taxpayer, { facts: { age: 70, individual_age_at_close_of_calendar_year: 70 } }], 3);
    expect(parent.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    // A spouse on a separate return fails the joint-return branch on the
    // stated filing status.
    const separate = await lookup([taxpayer, { facts: { is_spouse_of_taxpayer: true, age: 70 } }], 2);
    expect(numericOutput(separate, "senior_deduction")).toBe(0);
    expect(separate.applied.notes.filter(isMemberCountWarning)).toEqual([]);
  }, 60_000);

  // Review r4, finding 2: eitc_qualifying_child and ctc_qualifying_child
  // list only part of their tests (`requires_partial`). An 18-year-old who
  // filed a joint return of its own, with its residence unstated, was told
  // it failed only on facts no one stated; so was a child stated to fall
  // under the noncitizen exception. A warning now names a member only when
  // its gate holds with the listed unstated facts set.
  it("names a member only when setting its unstated facts makes the gate hold", async () => {
    const { individual_principal_place_of_abode_with_taxpayer_fraction: _, ...noResidence } = probeChild.facts!;
    const lookup = (output: string, facts: Facts) =>
      computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 3 },
        members: [taxpayer, { facts }],
        outputsOverride: [output],
      });
    const jointReturn = await lookup("eitc_maximum", {
      ...noResidence,
      age: 18,
      individual_age_at_close_of_calendar_year: 18,
      filing_status: 1,
      return_filed_only_for_claim_of_refund: false,
    });
    expect(numericOutput(jointReturn, "eitc_maximum")).toBe(664);
    expect(jointReturn.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    // The same child with no return of its own is named, and holds the gate
    // once its residence is set.
    const residence = await lookup("eitc_maximum", noResidence);
    expect(residence.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(/ Member 2 fails it only on facts no one stated: /),
    ]);
    const residenceSet = await lookup("eitc_maximum", probeChild.facts!);
    expect(numericOutput(residenceSet, "eitc_maximum")).toBe(4427);

    const ctcChildFacts = { age: 10, ctc_child_satisfies_dependency_rules: true };
    const noncitizen = await lookup("ctc_qualifying_children_count", { ...ctcChildFacts, certain_noncitizen_exception_applies: true });
    expect(numericOutput(noncitizen, "ctc_qualifying_children_count")).toBe(0);
    expect(noncitizen.applied.notes.filter(isMemberCountWarning)).toEqual([]);
    const deductionUnstated = await lookup("ctc_qualifying_children_count", ctcChildFacts);
    expect(deductionUnstated.applied.notes.filter(isMemberCountWarning)).toEqual([
      expect.stringMatching(/ Member 2 fails it only on facts no one stated: /),
    ]);
  }, 60_000);

  // Review r4, finding 3: a child's missing name or late TIN feeds no rule,
  // but keeps the TIN assumption off. The aux-slot warning said the headline
  // ignored it and suggested the aggregate slot, which set true would undo
  // what the user said.
  it("says an identification fact that feeds no rule kept the TIN assumption off", async () => {
    const stated: Facts[] = [{ qualifying_child_name_included_on_return: false }, { qualifying_child_tin_issued_on_or_before_return_due_date: false }];
    for (const missing of stated) {
      const [name] = Object.keys(missing);
      const result = await computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 3 },
        members: [taxpayer, { facts: { ...probeChild.facts, ...missing } }],
        outputsOverride: ["eitc_maximum"],
      });
      expect(numericOutput(result, "eitc_maximum")).toBe(664);
      expect(result.applied.notes.some((n) => n.includes(`"${name}"`) && n.startsWith("WARNING"))).toBe(false);
      expect(result.applied.notes).toContainEqual(
        `fact "${name}" (in members[1].facts) feeds no rule itself, but it kept the app from assuming ${TIN}=true for the members it applies to. Keep it as the user stated it.`
      );
    }
    // Set true, it changes nothing, and the aux warning stands.
    const harmless = buildRequest({
      program: fiit,
      period: "2026",
      members: [taxpayer, { facts: { ...probeChild.facts, qualifying_child_name_included_on_return: true } }],
    });
    expect(harmless.applied.notes).toContainEqual(expect.stringMatching(/^WARNING: fact "qualifying_child_name_included_on_return" .* the headline ignores it\./));

    // Review r5: set false at the top level and overridden true on every
    // member, it keeps nothing off, so it gets no guard note. Overridden on
    // the taxpayer only, it still reaches the child.
    const named = { ...probeChild.facts, qualifying_child_name_included_on_return: true };
    const lookup = (members: MemberSpec[]) =>
      computeProgram({
        program: fiit,
        period: "2026",
        facts: { filing_status: 3, qualifying_child_name_included_on_return: false },
        members,
        outputsOverride: ["eitc_maximum"],
      });
    const isGuardNote = (n: string) => n.includes("it kept the app from assuming");
    const overridden = await lookup([{ facts: { ...taxpayer.facts, qualifying_child_name_included_on_return: true } }, { facts: named }]);
    expect(numericOutput(overridden, "eitc_maximum")).toBe(4427);
    expect(overridden.applied.notes.filter(isGuardNote)).toEqual([]);
    expect(overridden.applied.notes).toContainEqual(
      expect.stringMatching(/^WARNING: fact "qualifying_child_name_included_on_return" \(in facts, members\[0\]\.facts, members\[1\]\.facts\) .* the headline ignores it\./)
    );
    const reachesChild = await lookup([{ facts: { ...taxpayer.facts, qualifying_child_name_included_on_return: true } }, probeChild]);
    expect(numericOutput(reachesChild, "eitc_maximum")).toBe(664);
    expect(reachesChild.applied.notes.filter(isGuardNote)).toEqual([
      expect.stringMatching(/^fact "qualifying_child_name_included_on_return" feeds no rule itself/),
    ]);
  }, 60_000);

  // Review r4 (noted as predating this PR): a top-level "the child's SSN
  // isn't on the return" also kept the senior SSN assumption off, so a
  // taxpayer of 70 got a $0 senior deduction. Each assumption now ignores
  // the other's facts.
  it("keeps a child's identification facts out of the senior SSN assumption", async () => {
    const result = await computeProgram({
      program: fiit,
      period: "2026",
      facts: { filing_status: 3, qualifying_child_ssn_included_on_return: false },
      members: [{ facts: { is_taxpayer: true, age: 70, individual_age_at_close_of_calendar_year: 70 } }, child()],
      outputsOverride: ["senior_deduction"],
    });
    expect(numericOutput(result, "senior_deduction")).toBe(6000);
  }, 30_000);

  // Invariants, for any number of children (0–5), each described in full
  // (its relationship stated, left out, or denied) or by age alone, with the
  // TIN unstated, stated true or stated false, and linked through every
  // member relation or through dependent_of_tax_unit only. A child "holds"
  // when described in full with its relationship stated and its TIN not
  // stated false.
  //  - the maximum is the Rev. Proc. 2025-32 amount for the linked children
  //    who hold (three or more capped at three);
  //  - the TIN assumption is disclosed for exactly the children who hold
  //    with the TIN unstated (only they then count, or would if linked);
  //  - a warning names exactly the unlinked children who hold, on both paths;
  //  - with no child counted and none stranded that way, the lookup's warning
  //    names exactly the linked children whose TIN isn't stated false and
  //    who are described by age alone or with their relationship left out
  //    (they fail only on facts no one stated); a child failing on its stated
  //    TIN or denied relationship is never named, and computes never carry
  //    it;
  //  - lookup_value and compute's extra_outputs agree on the value and on
  //    every member's eitc_qualifying_child (two paths, one semantics).
  it("matches the maximum table, disclosures and warnings for any mix of children, TINs and links", async () => {
    const childSpec = fc.record({
      tin: fc.constantFrom<boolean | undefined>(undefined, true, false),
      linked: fc.boolean(),
      ageOnly: fc.boolean(),
      relationship: fc.constantFrom<Relationship>("stated", "unstated", "denied"),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(childSpec, { maxLength: 5 }), async (children) => {
        const members = [
          taxpayer,
          ...children.map(({ tin, linked, ageOnly, relationship }) => ({
            ...child(tin, ageOnly, relationship),
            ...(!linked && { relations: ["dependent_of_tax_unit"] }),
          })),
        ];
        const options = { program: fiit, period: "2026", facts: { filing_status: 3 } as Facts, members };
        const lookup = await computeProgram({ ...options, outputsOverride: ["eitc_maximum"] });
        const compute = await computeProgram({ ...options, extraOutputs: ["eitc_maximum"] });
        const which = (test: (c: (typeof children)[number]) => boolean) =>
          children.flatMap((c, i) => (test(c) ? [i + 2] : []));
        const holds = (c: (typeof children)[number]) => c.tin !== false && !c.ageOnly && c.relationship === "stated";
        const holders = which(holds);
        const counted = which((c) => holds(c) && c.linked);
        expect(numericOutput(lookup, "eitc_maximum")).toBe(maximumFor(counted.length));
        expect(numericOutput(compute, "eitc_maximum")).toBe(maximumFor(counted.length));
        const disclosed = (r: typeof lookup) => r.applied.assumed_facts?.find((a) => a.slot === TIN)?.members ?? [];
        const unstated = which((c) => holds(c) && c.tin === undefined);
        expect(disclosed(lookup)).toEqual(unstated);
        expect(disclosed(compute)).toEqual(unstated);
        const named = (result: typeof lookup, pattern: RegExp) =>
          result.applied.notes
            .map((n) => pattern.exec(n)?.[1])
            .filter(Boolean)
            .flatMap((list) => list!.split(", ").map(Number));
        const unlinked = /^WARNING: members? ([\d, ]+) holds? eitc_qualifying_child but/;
        const stranded = holders.filter((m) => !counted.includes(m));
        expect(named(lookup, unlinked)).toEqual(stranded);
        expect(named(compute, unlinked)).toEqual(stranded);
        const uncounted = /^WARNING: eitc_maximum counts members through eitc_qualifying_child, .* (?:none of them|that member didn't) counted? through it\. Members? ([\d, ]+) fails? it only on facts no one stated/;
        const meant = which(
          ({ tin, ageOnly, linked, relationship }) => tin !== false && linked && (ageOnly || relationship === "unstated")
        );
        expect(named(lookup, uncounted)).toEqual(counted.length === 0 && stranded.length === 0 ? meant : []);
        expect(named(compute, uncounted)).toEqual([]);
        members.forEach((_, i) => {
          expect(memberCheck(lookup, i + 1, GATE).value).toBe(memberCheck(compute, i + 1, GATE).value);
        });
      }),
      { seed: 20261026, numRuns: 40 }
    );
  }, 240_000);
});
