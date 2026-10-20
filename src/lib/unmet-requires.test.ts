import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import type { ExecutionResponse, OutputValue } from "./engine";
import {
  buildRequest,
  computeProgram,
  queryKey,
  shapeResult,
  type BuildOptions,
  type Facts,
  type MemberSpec,
} from "./request-builder";
import { tools } from "./tools";
import { engineAvailable, memberCheck, numericOutput } from "../../scripts/snap-scenarios";

// 26 USC 24(h)(7): a child counts for the $2,200 credit only with the
// child's SSN and the taxpayer's (or spouse's) SSN on the return. us-fiit
// reads all four SSN facts on each child's own Person record. In the
// 2026-10-19 gpt-6-luna eval the model set the child's two facts on the
// children and the taxpayer/spouse ones on the parents, so both children
// fell back to the $500 other-dependent credit. The failed check's
// `requires` listed all five facts the model had set somewhere, so the
// retry changed nothing: MFJ, two children, $420,000 gave $0, not $3,400.
// `requires` now lists only what the member's own inputs don't meet.
const fiit = getProgram("us-fiit")!;
const GATE = "ctc_qualifying_child_under_subsection_h";
const TP_SSN_INCLUDED = "taxpayer_or_spouse_ssn_included_on_return";
const TP_SSN_VALID = "taxpayer_or_spouse_ssn_is_valid_for_subsection_h";
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

// Each child as the model recorded it (fiit-ctc-phaseout, first compute).
const recordedChild: MemberSpec = {
  facts: {
    age: 10,
    individual_age_at_close_of_calendar_year: 10,
    individual_is_younger_than_taxpayer: true,
    individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
    individual_principal_place_of_abode_with_taxpayer_fraction: 1,
    qualifying_child_principal_place_of_abode_is_in_united_states: true,
    qualifying_child_name_age_and_tin_included_on_return: true,
    qualifying_child_ssn_included_on_return: true,
    qualifying_child_ssn_is_valid_for_subsection_h: true,
    ctc_child_satisfies_dependency_rules: true,
    ctc_child_satisfies_subsection_c: true,
    ctc_child_deduction_allowed: true,
    taxpayer_is_parent_of_individual: true,
  },
};
// "We're married filing jointly with $420,000 of income and two young kids
// with SSNs. Do we still get any child tax credit in 2026?" The call left
// the period unset, which the app evaluated at 2026-10. Its two unknown
// extra_outputs names (skipped by the tool) are left out.
const recordedCall = (extra: Facts = {}, child: MemberSpec = recordedChild): BuildOptions => ({
  program: fiit,
  period: "2026-10",
  facts: {
    adjusted_gross_income: 420000,
    filing_status: 1,
    ctc_phaseout_joint_threshold_applies: true,
    taxpayer_includes_required_social_security_number_on_return: true,
    spouse_includes_required_social_security_number_on_return: true,
    ...extra,
  },
  members: [
    { facts: { is_taxpayer: true, filing_status: 1, [TP_SSN_INCLUDED]: true } },
    {
      facts: {
        is_spouse_of_taxpayer: true,
        filing_status: 1,
        spouse_includes_required_social_security_number_on_return: true,
        [TP_SSN_INCLUDED]: true,
      },
    },
    child,
    child,
  ],
  extraOutputs: ["ctc_maximum_before_phaseout", "ctc_phaseout_amount", "ctc_phaseout_threshold"],
});
// fiit-wages-only-honesty, first compute: "We're a married couple filing
// jointly with two young kids and $95,000 in wages."
const wagesCall = (extra: Facts = {}): BuildOptions => ({
  program: fiit,
  period: "2026",
  facts: {
    filing_status: 1,
    adjusted_gross_income: 95000,
    employee_compensation_includible_in_gross_income: 95000,
    taxpayer_married_at_close_of_taxable_year: true,
    taxpayer_includes_required_social_security_number_on_return: true,
    spouse_includes_required_social_security_number_on_return: true,
    ctc_phaseout_joint_threshold_applies: true,
    ...extra,
  },
  members: [
    { facts: { is_taxpayer: true, filing_status: 1, [TP_SSN_INCLUDED]: true } },
    { facts: { is_spouse_of_taxpayer: true, filing_status: 1, [TP_SSN_INCLUDED]: true } },
    recordedChild,
    recordedChild,
  ],
  extraOutputs: ["ctc_after_advance_payments"],
});
const ctc = (result: Awaited<ReturnType<typeof computeProgram>>) => numericOutput(result, "ctc_after_advance_payments");

// A hand-built explain response: every member gate at every member, the
// given outcome, and no trace.
function shapeChecks(options: BuildOptions, outcome: (gate: string, memberId: string) => "holds" | "not_holds") {
  const built = buildRequest(options);
  const gates = built.queried.filter((o) => built.memberCheckNames.has(o.name));
  const response: ExecutionResponse = {
    metadata: { requested_mode: "explain", actual_mode: "explain", fallback_reason: null },
    results: built.memberCheckIds.map((id) => ({
      entity_id: id,
      period: { period_kind: "tax_year", start: "2026-01-01", end: "2026-12-31" },
      outputs: Object.fromEntries(
        gates.map((g): [string, OutputValue] => [
          queryKey(g),
          { kind: "judgment", name: g.name, id: queryKey(g), outcome: outcome(g.name, id) },
        ])
      ),
      trace: {},
    })),
  };
  return shapeResult(fiit, built, response);
}

describe("requires on a failed check, hand-built response", () => {
  it("lists only the entries the member's own inputs don't meet", () => {
    const result = shapeChecks(recordedCall(), (gate, id) =>
      gate === GATE || !["person:3", "person:4"].includes(id) ? "not_holds" : "holds"
    );
    // The catalog lists all five facts; the child already has three.
    expect(fiit.outputs.find((o) => o.name === GATE)!.requires).toHaveLength(5);
    expect(memberCheck(result, 3, GATE).requires).toEqual([
      { slot: TP_SSN_INCLUDED, value: true },
      { slot: TP_SSN_VALID, value: true },
    ]);
    expect(result.member_checks?.find((m) => m.member === 4)?.same_as).toBe(3);
    // The taxpayer set its own SSN fact, so its list keeps the child facts.
    expect(memberCheck(result, 1, GATE).requires?.map((r) => r.slot)).toEqual([
      "ctc_child_satisfies_subsection_c",
      "qualifying_child_ssn_included_on_return",
      TP_SSN_VALID,
      "qualifying_child_ssn_is_valid_for_subsection_h",
    ]);
  });

  it("drops requires once every entry is met, and keeps requires_partial", () => {
    const child: MemberSpec = { facts: { ...recordedChild.facts, [TP_SSN_INCLUDED]: true, [TP_SSN_VALID]: true } };
    const failing = [GATE, "ctc_qualifying_child"];
    const result = shapeChecks(recordedCall({}, child), (gate, id) =>
      ["person:3", "person:4"].includes(id) && !failing.includes(gate) ? "holds" : "not_holds"
    );
    // Every listed fact holds on the child, so neither failure is theirs.
    const gate = memberCheck(result, 3, GATE);
    expect(gate.value).toBe("not_holds");
    expect(gate.requires).toBeUndefined();
    expect(gate.requires_partial).toBeUndefined();
    // ctc_qualifying_child (dependency rules, age < 17, deduction allowed)
    // has conditional tests beyond its list: requires_partial still says so.
    const check = memberCheck(result, 3, "ctc_qualifying_child");
    expect(check.value).toBe("not_holds");
    expect(check.requires).toBeUndefined();
    expect(check.requires_partial).toBe(true);
  });

  it("keeps a threshold the recorded value fails", () => {
    const result = shapeChecks(recordedCall(), () => "not_holds");
    // The taxpayer's age is unset (0): age < 17 holds, so it is left out.
    expect(memberCheck(result, 1, "ctc_qualifying_child").requires).not.toContainEqual(
      expect.objectContaining({ slot: "age" })
    );
    const older = shapeChecks(recordedCall({}, { facts: { ...recordedChild.facts, age: 17 } }), () => "not_holds");
    expect(memberCheck(older, 3, "ctc_qualifying_child").requires).toContainEqual({ slot: "age", op: "lt", value: 17 });
  });
});

describe.skipIf(!hasEngine)("real-engine 24(h)(7) SSN facts", () => {
  it("the recorded call: both children fall to the other-dependent credit, and requires names the parent SSN facts", async () => {
    const result = await computeProgram(recordedCall());
    expect(ctc(result)).toBe(0);
    // 2 × $500 other-dependent credit, all phased out at $420,000.
    expect(numericOutput(result, "ctc_maximum_before_phaseout")).toBe(1000);
    expect(numericOutput(result, "ctc_phaseout_amount")).toBe(1000);

    const check = memberCheck(result, 3, GATE);
    expect(check.value).toBe("not_holds");
    expect(check.requires).toEqual([
      { slot: TP_SSN_INCLUDED, value: true },
      { slot: TP_SSN_VALID, value: true },
    ]);
    expect(check.failed_because).toEqual([
      {
        name: "ctc_child_ssn_requirement_satisfied_under_subsection_h",
        legal_id: "us:statutes/26/24/h#ctc_child_ssn_requirement_satisfied_under_subsection_h",
        source: "26 USC 24(h)(7)",
      },
    ]);
    expect(memberCheck(result, 3, "ctc_other_dependent_under_subsection_h").value).toBe("holds");
    expect(result.member_checks?.find((m) => m.member === 4)?.same_as).toBe(3);
  }, 30_000);

  it("the recorded retry: with the validity fact at the top level, requires names the one fact still unset", async () => {
    // The model's second compute added only TP_SSN_VALID, at the top level.
    const result = await computeProgram(recordedCall({ [TP_SSN_VALID]: true }));
    expect(ctc(result)).toBe(0);
    expect(memberCheck(result, 3, GATE).requires).toEqual([{ slot: TP_SSN_INCLUDED, value: true }]);
  }, 30_000);

  it("setting the child's requires in the top-level facts and recomputing once gives $3,400", async () => {
    const first = await computeProgram(recordedCall());
    const set: Facts = {};
    for (const req of memberCheck(first, 3, GATE).requires ?? []) {
      if (!req.op) set[req.slot] = req.value;
    }
    const retry = await computeProgram(recordedCall(set));
    // 2 × $2,200 − $50 × 20 (each $1,000 over $400,000) = $3,400.
    expect(numericOutput(retry, "ctc_maximum_before_phaseout")).toBe(4400);
    expect(ctc(retry)).toBe(3400);
    const check = memberCheck(retry, 3, GATE);
    expect(check.value).toBe("holds");
    expect(check.requires).toBeUndefined();
  }, 30_000);

  it("setting them on each child instead gives the same $3,400", async () => {
    const child: MemberSpec = { facts: { ...recordedChild.facts, [TP_SSN_INCLUDED]: true, [TP_SSN_VALID]: true } };
    expect(ctc(await computeProgram(recordedCall({}, child)))).toBe(3400);
  }, 30_000);

  it("lookup_value on the failed gate names the same two facts; once it holds, the whole rule", async () => {
    const lookup = (child: MemberSpec) =>
      tools.lookup_value.execute!(
        { program: "us-fiit", output: GATE, period: "2026", members: [child] },
        { toolCallId: "lookup", messages: [] }
      );
    const failed = await lookup(recordedChild);
    expect(failed).toMatchObject({ value: "not_holds" });
    expect(failed).toHaveProperty("requires", [
      { slot: TP_SSN_INCLUDED, value: true },
      { slot: TP_SSN_VALID, value: true },
    ]);
    const held = await lookup({ facts: { ...recordedChild.facts, [TP_SSN_INCLUDED]: true, [TP_SSN_VALID]: true } });
    expect(held).toMatchObject({ value: "holds" });
    expect(held).toHaveProperty("requires", fiit.outputs.find((o) => o.name === GATE)!.requires);
  }, 30_000);

  it("$95,000: the recorded call gives $1,000, the corrected one $4,400", async () => {
    const first = await computeProgram(wagesCall());
    expect(ctc(first)).toBe(1000);
    const requires = memberCheck(first, 3, GATE).requires ?? [];
    expect(requires.map((r) => r.slot)).toEqual([TP_SSN_INCLUDED, TP_SSN_VALID]);
    const retry = await computeProgram(wagesCall(Object.fromEntries(requires.map((r) => [r.slot, r.value]))));
    expect(ctc(retry)).toBe(4400); // oracle fiit-mfj-2kids (PE ctc_value 4,400)
  }, 30_000);
});
