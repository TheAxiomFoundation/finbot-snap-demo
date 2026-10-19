import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getProgram } from "../src/lib/catalog";
import {
  NotMemberInputError,
  UnitFactUnsetError,
  UnknownRelationError,
  buildRequest,
  computeProgram,
  type BuildOptions,
  type MemberSpec,
} from "../src/lib/request-builder";
import { engineAvailable, memberCheck, numericOutput } from "./snap-scenarios";

// The EITC starter: "Single mom, kids 8 and 5 with SSNs, $40,000 in wages in
// 2026." The model often lists the taxpayer first. Member checks used to
// cover member 1 only, so the taxpayer's own (expected) qualifying-child
// failure read as "the children don't qualify" and the answer stopped at $0.
const fiit = () => getProgram("us-fiit")!;
const child = (age: number): MemberSpec => ({
  facts: {
    age,
    qualifying_child_principal_place_of_abode_is_in_united_states: true,
    qualifying_child_name_age_and_tin_included_on_return: true,
    individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
    individual_is_younger_than_taxpayer: true,
    individual_principal_place_of_abode_with_taxpayer_fraction: 1,
    individual_own_support_fraction_provided_by_individual: 0,
  },
});
const taxpayer: MemberSpec = { facts: { age: 34 } };
const hohTwoKids = (members: MemberSpec[]): BuildOptions => ({
  program: fiit(),
  period: "2026",
  facts: {
    filing_status: 3,
    adjusted_gross_income: 40000,
    taxable_income: 15850,
    employee_compensation_includible_in_gross_income: 40000,
    taxpayer_includes_required_social_security_number_on_return: true,
  },
  members,
});

describe("member-check queries", () => {
  it("query every gate at every listed member", () => {
    const built = buildRequest(hohTwoKids([taxpayer, child(8), child(5)]));
    expect(built.memberCheckIds).toEqual(["person:1", "person:2", "person:3"]);
    const gateKeys = fiit().outputs.filter((o) => built.memberCheckNames.has(o.name)).map((o) => o.id ?? o.name);
    expect(gateKeys).toContain("us:statutes/26/32#eitc_qualifying_child");
    for (const id of built.memberCheckIds) {
      const outputs = built.request.queries.filter((q) => q.entity_id === id).flatMap((q) => q.outputs);
      expect(outputs.sort()).toEqual([...gateKeys].sort());
    }
  });

  it("check only member 1 when members are synthesized from a count", () => {
    const built = buildRequest({ program: getProgram("us-fl-snap")!, facts: { household_size: 3 } });
    expect(built.applied.member_count).toBe(3);
    expect(built.memberCheckIds).toEqual(["person:1"]);
  });
});

// gpt-6-luna on the same starter: the TaxUnit-only SSN fact placed under the
// taxpayer's members[] entry. Member instances record Person slots only, so
// the fact used to vanish with no note and EITC came back $0.
const SSN_ON_RETURN = "taxpayer_includes_required_social_security_number_on_return";
const withoutSsn = (members: MemberSpec[]): BuildOptions => {
  const { [SSN_ON_RETURN]: _, ...facts } = hohTwoKids(members).facts!;
  return { ...hohTwoKids(members), facts };
};
const ssnUnderTaxpayer = (value = true) => withoutSsn([{ facts: { age: 34, [SSN_ON_RETURN]: value } }, child(8), child(5)]);
const rejection = (options: BuildOptions): NotMemberInputError => {
  try {
    buildRequest(options);
  } catch (err) {
    if (err instanceof NotMemberInputError) return err;
    throw err;
  }
  throw new Error("buildRequest accepted the misplaced fact");
};
const recorded = (options: BuildOptions, entityId: string, slot: string) =>
  buildRequest(options)
    .request.dataset.inputs.filter((i) => i.entity_id === entityId && i.name.endsWith(`#input.${slot}`))
    .map((i) => i.value.value);

describe("member facts on slots with no member scope", () => {
  it("reject a TaxUnit-only fact under a member, naming its path and scope", () => {
    const err = rejection(ssnUnderTaxpayer());
    expect(err).toMatchObject({
      kind: "not_member_input",
      memberEntity: "Person",
      misplaced: [{ path: `members[0].facts.${SSN_ON_RETURN}`, slot: SSN_ON_RETURN, entities: ["TaxUnit"] }],
    });
    expect(err.message).toContain("members[].facts take Person-scope slots only");
  });

  it("list every misplaced fact in one error", () => {
    // adjusted_gross_income repeats its top-level value, so it is not listed.
    const err = rejection(
      withoutSsn([
        { facts: { age: 34, [SSN_ON_RETURN]: true, adjusted_gross_income: 40000 } },
        { facts: { ...child(8).facts, [SSN_ON_RETURN]: true } },
      ])
    );
    expect(err.misplaced.map((m) => m.path)).toEqual([
      `members[0].facts.${SSN_ON_RETURN}`,
      `members[1].facts.${SSN_ON_RETURN}`,
    ]);
  });

  it("accept a copy equal to the top-level value, reject a different one", () => {
    const copy = hohTwoKids([{ facts: { age: 34, [SSN_ON_RETURN]: true } }, child(8), child(5)]);
    expect(recorded(copy, "taxunit:1", SSN_ON_RETURN)).toEqual([true]);
    const conflict = hohTwoKids([{ facts: { age: 34, [SSN_ON_RETURN]: false } }, child(8), child(5)]);
    expect(rejection(conflict).misplaced.map((m) => m.slot)).toEqual([SSN_ON_RETURN]);
  });


  it("reject every member fact for a program with no member entity", () => {
    const program = getProgram("us-ny-income-tax")!;
    expect(program.member_entity).toBeNull();
    const err = rejection({ program, members: [{ facts: { ny_pit_pilot_state_taxable_income: 50000 } }] });
    expect(err).toMatchObject({ kind: "not_member_input", memberEntity: null });
    expect(err.message).toContain("has no member entity");
  });
});

describe.skipIf(!engineAvailable())("real-engine member facts with no member scope", () => {
  it("refuse the misplaced SSN fact instead of computing EITC without it", async () => {
    // Without the fact, EITC is $0: what the dropped fact used to produce.
    const dropped = await computeProgram(withoutSsn([taxpayer, child(8), child(5)]));
    expect(numericOutput(dropped, "eitc")).toBe(0);
    await expect(computeProgram(ssnUnderTaxpayer())).rejects.toBeInstanceOf(NotMemberInputError);
  });

  it("an equal copy under the taxpayer computes the same $3,923 as the top level", async () => {
    const result = await computeProgram(hohTwoKids([{ facts: { age: 34, [SSN_ON_RETURN]: true } }, child(8), child(5)]));
    expect(Math.round(numericOutput(result, "eitc"))).toBe(3923);
  });
});

describe.skipIf(!engineAvailable())("real-engine member checks", () => {
  it("taxpayer first: the children's EITC gate holds and EITC = $3,923", async () => {
    const result = await computeProgram(hohTwoKids([taxpayer, child(8), child(5)]));
    expect(Math.round(numericOutput(result, "eitc"))).toBe(3923);

    const taxpayerGate = memberCheck(result, 1, "eitc_qualifying_child");
    expect(taxpayerGate.value).toBe("not_holds");
    expect(taxpayerGate.failed_because?.map((f) => f.name)).toContain("qualifying_child_relationship");
    expect(memberCheck(result, 2, "eitc_qualifying_child").value).toBe("holds");
    expect(memberCheck(result, 3, "eitc_qualifying_child").value).toBe("holds");
    // Identical siblings are reported once.
    expect(result.member_checks?.find((m) => m.member === 3)).toEqual({ member: 3, same_as: 2 });
  });

  it("member order does not change the EITC or the children's checks", async () => {
    const result = await computeProgram(hohTwoKids([child(8), child(5), taxpayer]));
    expect(Math.round(numericOutput(result, "eitc"))).toBe(3923);
    expect(memberCheck(result, 1, "eitc_qualifying_child").value).toBe("holds");
    expect(memberCheck(result, 2, "eitc_qualifying_child").value).toBe("holds");
    expect(memberCheck(result, 3, "eitc_qualifying_child").value).toBe("not_holds");
  });
});

const thrown = <E extends Error>(options: BuildOptions, type: new (...args: never[]) => E): E => {
  try {
    buildRequest(options);
  } catch (err) {
    if (err instanceof type) return err;
    throw err;
  }
  throw new Error(`buildRequest did not throw ${type.name}`);
};
const linked = (options: BuildOptions, memberId: string) =>
  buildRequest(options)
    .request.dataset.relations.filter((r) => r.tuple.includes(memberId))
    .map((r) => r.name.split("#").pop());
const withRelations = (spec: MemberSpec, relations: string[]): MemberSpec => ({ ...spec, relations });

// A relation name that matched nothing used to link the member through no
// relation: the children dropped out of every aggregation and EITC fell
// from $3,923 to $0 with no note.
describe("members[].relations names", () => {
  it("reject an unknown name at every path, with nearest matches", () => {
    const err = thrown(
      hohTwoKids([taxpayer, withRelations(child(8), ["dependent"]), withRelations(child(5), ["qualifying_child_of_tax_unit", "dependent"])]),
      UnknownRelationError
    );
    expect(err.kind).toBe("unknown_relation");
    expect(err.unknown).toEqual([
      { path: "members[1].relations[0]", relation: "dependent", suggestions: ["dependent_of_tax_unit"] },
      { path: "members[2].relations[1]", relation: "dependent", suggestions: ["dependent_of_tax_unit"] },
    ]);
    expect(err.known).toContain("qualifying_child_of_tax_unit");
    expect(err.message).toBe('unknown relation "dependent" for us-fiit; closest relations: dependent_of_tax_unit');
  });

  it("accept short and full names, and link through exactly those", () => {
    const options = hohTwoKids([
      taxpayer,
      withRelations(child(8), ["qualifying_child_of_tax_unit", "us:statutes/26/24/h#relation.dependent_of_tax_unit"]),
    ]);
    expect(linked(options, "person:2")).toEqual(["relation.dependent_of_tax_unit", "relation.qualifying_child_of_tax_unit"]);
    expect(linked(options, "person:1")).toHaveLength(fiit().relations.length);
  });

  it("refuse any name on a program with no member relations", () => {
    const program = getProgram("us-ny-tanf")!;
    const err = thrown({ program, members: [{ relations: ["member_of_household"] }] }, UnknownRelationError);
    expect(err.known).toEqual([]);
    expect(err.message).toContain("us-ny-tanf has no member relations");
  });
});

// The aux-slot warning used to read top-level facts only.
describe("auxiliary member facts", () => {
  const ABODE_FRACTION = "child_principal_abode_fraction_of_taxable_year";
  const auxWarnings = (options: BuildOptions) =>
    buildRequest(options).applied.notes.filter((n) => n.includes("targets an auxiliary slot"));

  it("warn once per slot, with every members[i] path", () => {
    const kid = (age: number): MemberSpec => ({ facts: { age, [ABODE_FRACTION]: 1 } });
    const warnings = auxWarnings(hohTwoKids([taxpayer, kid(8), kid(5)]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      new RegExp(`^WARNING: fact "${ABODE_FRACTION}" \\(in members\\[1\\]\\.facts, members\\[2\\]\\.facts\\) targets an auxiliary slot`)
    );
  });

  it("warn on a member fact in a SNAP program", () => {
    const fact = "act_was_for_purpose_of_using_presenting_transferring_acquiring_receiving_or_possessing_program_benefits";
    const warnings = auxWarnings({ program: getProgram("us-fl-snap")!, members: [{ facts: { [fact]: true } }, {}] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${fact}" (in members[0].facts)`);
  });

  it("keep the top-level warning as it was", () => {
    const options = hohTwoKids([taxpayer, { facts: { age: 8 } }]);
    const warnings = auxWarnings({ ...options, facts: { ...options.facts, [ABODE_FRACTION]: 1 } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(new RegExp(`^WARNING: fact "${ABODE_FRACTION}" targets an auxiliary slot`));
  });
});

// us-fiit filing_status is read on Person and on TaxUnit. A value under a
// member alone reached that Person; the TaxUnit kept the default 0.
describe("member facts on a slot the unit also reads", () => {
  const noFilingStatus = (members: MemberSpec[]): BuildOptions => {
    const { filing_status: _, ...facts } = hohTwoKids(members).facts!;
    return { ...hohTwoKids(members), facts };
  };

  it("reject filing_status under members when the top level does not set it", () => {
    const err = thrown(
      noFilingStatus([{ facts: { age: 34, filing_status: 3 } }, { facts: { ...child(8).facts, filing_status: 0 } }]),
      UnitFactUnsetError
    );
    expect(err).toMatchObject({
      kind: "unit_fact_unset",
      memberEntity: "Person",
      unset: [{ slot: "filing_status", paths: ["members[0].facts.filing_status", "members[1].facts.filing_status"], entities: ["TaxUnit"] }],
    });
  });

  it("with a top-level value, a member's own value reaches that member only", () => {
    const options = { ...hohTwoKids([{ facts: { age: 34, is_taxpayer: true } }, { facts: { ...child(8).facts, filing_status: 0 } }]) };
    options.facts = { ...options.facts, filing_status: 1 };
    expect(recorded(options, "taxunit:1", "filing_status")).toEqual([1]);
    expect(recorded(options, "person:1", "filing_status")).toEqual([1]);
    expect(recorded(options, "person:2", "filing_status")).toEqual([0]);
  });

  it("leave an auxiliary slot with a member scope to the warning", () => {
    // gross_income is an aux slot on Person and Household in us-az-snap.
    const built = buildRequest({ program: getProgram("us-az-snap")!, members: [{ facts: { gross_income: 900 } }] });
    expect(built.applied.notes.some((n) => n.includes('"gross_income" (in members[0].facts)'))).toBe(true);
  });
});

interface OracleCase {
  id: string;
  program: string;
  axiom: { facts: BuildOptions["facts"]; members: Array<{ facts: Record<string, unknown>; relations?: string[] }> };
}
const oracle = JSON.parse(readFileSync(path.join(__dirname, "oracle-cases.json"), "utf8")) as {
  period: string;
  cases: OracleCase[];
  shared_member_facts: Record<string, NonNullable<MemberSpec["facts"]>>;
};
const oracleOptions = (id: string, filingStatus: "top" | "member0" | "none"): BuildOptions => {
  const c = oracle.cases.find((x) => x.id === id)!;
  const { filing_status, ...facts } = c.axiom.facts!;
  const members = c.axiom.members.map((m, i): MemberSpec => {
    const { $ref, ...own } = m.facts as { $ref?: string } & NonNullable<MemberSpec["facts"]>;
    const extra: NonNullable<MemberSpec["facts"]> = i === 0 && filingStatus === "member0" ? { filing_status } : {};
    return { facts: { ...($ref ? oracle.shared_member_facts[$ref] : {}), ...own, ...extra }, relations: m.relations };
  });
  return {
    program: getProgram(c.program)!,
    period: oracle.period,
    facts: filingStatus === "top" ? { ...facts, filing_status } : facts,
    members,
    extraOutputs: ["regular_tax_before_credits", "ctc_after_advance_payments"],
  };
};

describe.skipIf(!engineAvailable())("real-engine member relation names and unit facts", () => {
  it("refuse an unknown relation instead of computing EITC = $0", async () => {
    // Linked through no relation, the children count for nothing: what the
    // unknown name used to produce.
    const unlinked = await computeProgram(hohTwoKids([taxpayer, withRelations(child(8), []), withRelations(child(5), [])]));
    expect(numericOutput(unlinked, "eitc")).toBe(0);
    await expect(
      computeProgram(hohTwoKids([taxpayer, withRelations(child(8), ["dependent"]), withRelations(child(5), ["dependent"])]))
    ).rejects.toBeInstanceOf(UnknownRelationError);
    const short = await computeProgram(
      hohTwoKids([taxpayer, withRelations(child(8), ["qualifying_child_of_tax_unit"]), withRelations(child(5), ["qualifying_child_of_tax_unit"])])
    );
    expect(Math.round(numericOutput(short, "eitc"))).toBe(3923);
  });

  it("an auxiliary member fact warns and leaves EITC at $3,923", async () => {
    const kid = (age: number): MemberSpec => ({ facts: { ...child(age).facts, child_principal_abode_fraction_of_taxable_year: 1 } });
    const result = await computeProgram(hohTwoKids([taxpayer, kid(8), kid(5)]));
    expect(Math.round(numericOutput(result, "eitc"))).toBe(3923);
    expect(result.applied.notes.some((n) => n.includes('"child_principal_abode_fraction_of_taxable_year" (in members[1].facts, members[2].facts)'))).toBe(true);
  });

  it("fiit-mfj-2kids: filing_status under members[0] is refused, not computed as $8,528", async () => {
    // TaxUnit at the default 0: what the member-only value used to produce.
    const unset = await computeProgram(oracleOptions("fiit-mfj-2kids", "none"));
    expect(numericOutput(unset, "regular_tax_before_credits")).toBe(8528);
    await expect(computeProgram(oracleOptions("fiit-mfj-2kids", "member0"))).rejects.toBeInstanceOf(UnitFactUnsetError);
    const top = await computeProgram(oracleOptions("fiit-mfj-2kids", "top"));
    expect(numericOutput(top, "regular_tax_before_credits")).toBe(7040);
    expect(numericOutput(top, "ctc_after_advance_payments")).toBe(4400);
  });

  it("fiit-ctc-phaseout-420k: filing_status under members[0] is refused, not computed as CTC $0", async () => {
    const unset = await computeProgram(oracleOptions("fiit-ctc-phaseout-420k", "none"));
    expect(numericOutput(unset, "ctc_after_advance_payments")).toBe(0);
    await expect(computeProgram(oracleOptions("fiit-ctc-phaseout-420k", "member0"))).rejects.toBeInstanceOf(UnitFactUnsetError);
    const top = await computeProgram(oracleOptions("fiit-ctc-phaseout-420k", "top"));
    expect(numericOutput(top, "ctc_after_advance_payments")).toBe(3400);
  });
});
