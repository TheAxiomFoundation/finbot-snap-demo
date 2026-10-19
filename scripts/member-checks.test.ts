import { describe, expect, it } from "vitest";
import { getProgram } from "../src/lib/catalog";
import { buildRequest, computeProgram, type BuildOptions, type MemberSpec } from "../src/lib/request-builder";
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
