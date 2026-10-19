import { describe, expect, it } from "vitest";
import { getProgram } from "../src/lib/catalog";
import {
  NotMemberInputError,
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

  it("keep a slot that also has a member scope on that member only", () => {
    // filing_status is both a Person and a TaxUnit slot in us-fiit.
    const options = withoutSsn([{ facts: { age: 34, filing_status: 3 } }, child(8)]);
    const { filing_status: _, ...facts } = options.facts!;
    const built = { ...options, facts };
    expect(recorded(built, "person:1", "filing_status")).toEqual([3]);
    expect(recorded(built, "taxunit:1", "filing_status")).toEqual([0]);
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
