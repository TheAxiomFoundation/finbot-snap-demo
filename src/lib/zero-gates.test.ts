import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import type { DerivedTraceNode, ExecutionResponse, OutputValue } from "./engine";
import {
  buildRequest,
  computeProgram,
  queryKey,
  shapeResult,
  type BuildOptions,
  type Facts,
  type MemberSpec,
  type ShapedResult,
} from "./request-builder";
import { engineAvailable, numericOutput } from "../../scripts/snap-scenarios";

// us-fiit `eitc` is `if eitc_allowed then eitc_before_eligibility else 0`.
// eitc_allowed is a TaxUnit judgment: no member gate, no published output.
// A live gpt-6-luna call that left the taxpayer's SSN fact unset got EITC $0
// with every child passing eitc_qualifying_child and no failed check naming
// the fact. `zero_because` on the $0 output now names the gate the way a
// failed judgment output reads.
const fiit = getProgram("us-fiit")!;
const SSN_ON_RETURN = "taxpayer_includes_required_social_security_number_on_return";
const output = (name: string, slug = "us-fiit") => getProgram(slug)!.outputs.find((o) => o.name === name)!;
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

// The recorded call: 2026, HoH, two children age 10, $40,000 wages.
const recordedChild: MemberSpec = {
  facts: {
    age: 10,
    individual_age_at_close_of_calendar_year: 10,
    individual_is_younger_than_taxpayer: true,
    individual_is_child_of_taxpayer_or_descendant_of_such_child: true,
    child_resided_with_taxpayer_parent_for_longest_period: true,
    individual_principal_place_of_abode_with_taxpayer_fraction: 1,
    qualifying_child_principal_place_of_abode_is_in_united_states: true,
    qualifying_child_name_age_and_tin_included_on_return: true,
  },
};
const recordedCall = (extra: Facts = {}): BuildOptions => ({
  program: fiit,
  period: "2026",
  facts: {
    filing_status: 3,
    adjusted_gross_income: 40000,
    employee_compensation_includible_in_gross_income: 40000,
    ...extra,
  },
  members: [{ facts: { is_taxpayer: true, filing_status: 3 } }, recordedChild, recordedChild],
});

const zeroBecause = (result: ShapedResult, name: string) => result.outputs.find((o) => o.name === name)?.zero_because;

const CHILDLESS_ALTERNATIVES = {
  rule: "eitc_demographic_eligible",
  any_of: [
    [{ slot: "eitc_child_count", op: "gt", value: 0, computed: true }],
    [
      { slot: "childless_taxpayer_principal_place_of_abode_in_united_states_more_than_half_year", value: true },
      { slot: "childless_taxpayer_or_spouse_age_eligible_for_eitc", value: true },
      { slot: "taxpayer_is_dependent_for_section_151_to_another_taxpayer", value: false },
    ],
  ],
};
// eitc-childless-10k: "I'm 25, single, no kids, and earned $10,000 in 2026."
const childlessCall = (extra: Facts = {}): BuildOptions => ({
  program: fiit,
  period: "2026",
  facts: {
    filing_status: 0,
    adjusted_gross_income: 10000,
    employee_compensation_includible_in_gross_income: 10000,
    [SSN_ON_RETURN]: true,
    ...extra,
  },
  members: [{ facts: { is_taxpayer: true, age: 25, individual_age_at_close_of_calendar_year: 25 } }],
});

describe("zero gates in the catalog", () => {
  it("lists the judgment an `if J then X else 0` scalar is gated on", () => {
    expect(output("eitc").zero_unless).toEqual(["eitc_allowed"]);
    expect(output("snap_benefit", "us-co-snap").zero_unless).toEqual(["snap_eligible"]);
  });

  it("does not follow arithmetic, and judgments carry none", () => {
    // income_tax_before_refundable_credits subtracts credits from a gated sum.
    expect(output("income_tax_before_refundable_credits").zero_unless).toBeUndefined();
    expect(output("eitc_allowed").zero_unless).toBeUndefined();
  });

  it("keeps an `or` whose other branch tests a computed value", () => {
    // 26 USC 32(c)(1)(A)(ii): a qualifying child, or the childless tests.
    // Nothing can set eitc_child_count, but dropping the whole `or` for it
    // left the childless facts named nowhere.
    expect(output("eitc_demographic_eligible").requires_any).toContainEqual(CHILDLESS_ALTERNATIVES);
    expect(output("eitc_allowed").requires_any).toContainEqual(CHILDLESS_ALTERNATIVES);
  });

  it("marks sub-judgments a rule reads only negated", () => {
    // taxpayer SSN AND (NOT married OR spouse SSN)
    expect(output("eitc_identification_requirements_satisfied").negated_judgments).toEqual([
      "taxpayer_married_under_general_rule",
    ]);
    expect(output("eitc_allowed").negated_judgments).toBeUndefined();
  });
});

// A hand-built explain response for the recorded call: every main output at
// taxunit:1, with the trace the engine gives when the SSN fact is unset.
function syntheticResponse(
  options: BuildOptions,
  values: Record<string, number | "holds" | "not_holds">,
  trace: Record<string, DerivedTraceNode>
): ShapedResult {
  const built = buildRequest(options);
  const outputs: Record<string, OutputValue> = {};
  for (const o of built.queried) {
    if (built.memberCheckNames.has(o.name) || !(o.name in values)) continue;
    const value = values[o.name];
    const key = queryKey(o);
    outputs[key] =
      typeof value === "number"
        ? { kind: "scalar", name: o.name, id: key, dtype: "decimal", value: { kind: "decimal", value: String(value) } }
        : { kind: "judgment", name: o.name, id: key, outcome: value };
  }
  const response: ExecutionResponse = {
    metadata: { requested_mode: "explain", actual_mode: "explain", fallback_reason: null },
    results: [{ entity_id: "taxunit:1", period: { period_kind: "tax_year", start: "2026-01-01", end: "2026-12-31" }, outputs, trace }],
  };
  return shapeResult(fiit, built, response);
}
const id = (name: string) => queryKey(output(name));
const judgment = (name: string, outcome: "holds" | "not_holds", dependencies: string[] = []): DerivedTraceNode => ({
  kind: "judgment",
  name,
  id: id(name),
  outcome,
  source: output(name).source ?? undefined,
  dependencies: dependencies.map(id),
});
const scalar = (name: string, value: number, dependencies: string[]): DerivedTraceNode => ({
  kind: "scalar",
  name,
  id: id(name),
  value: { kind: "decimal", value: String(value) },
  dependencies: dependencies.map(id),
});
const traceOf = (...nodes: DerivedTraceNode[]) => Object.fromEntries(nodes.map((n) => [n.id!, n]));
// The engine's trace for the recorded call (eitc_before_eligibility and
// eitc_investment_income_eligible short-circuited, so absent).
const unsetSsnTrace = () =>
  traceOf(
    scalar("eitc", 0, ["eitc_allowed", "eitc_before_eligibility"]),
    judgment("eitc_allowed", "not_holds", [
      "eitc_demographic_eligible",
      "eitc_identification_requirements_satisfied",
      "eitc_investment_income_eligible",
    ]),
    judgment("eitc_demographic_eligible", "holds", ["taxpayer_married_under_general_rule"]),
    judgment("eitc_identification_requirements_satisfied", "not_holds", ["taxpayer_married_under_general_rule"]),
    judgment("taxpayer_married_under_general_rule", "not_holds")
  );

describe("zero_because on a hand-built response", () => {
  it("names the failed TaxUnit gate with its requires and failed sub-check", () => {
    const result = syntheticResponse(recordedCall(), { eitc: 0 }, unsetSsnTrace());
    expect(zeroBecause(result, "eitc")).toEqual([
      {
        name: "eitc_allowed",
        value: "not_holds",
        legal_id: "us:statutes/26/32#eitc_allowed",
        requires: [
          { slot: SSN_ON_RETURN, value: true },
          { slot: "eitc_relevant_investment_income", op: "lte", value: 12200 },
        ],
        requires_partial: true,
        // Not taxpayer_married_under_general_rule: the rule reads it negated,
        // and an unmarried head of household fails it as expected.
        failed_because: [
          {
            name: "eitc_identification_requirements_satisfied",
            legal_id: "us:statutes/26/32#eitc_identification_requirements_satisfied",
            source: "26 USC 32(c)(1)(E), 26 USC 32(m)",
          },
        ],
      },
    ]);
  });

  it("stays off a 0 that the gate did not force", () => {
    // Phased out: the gate holds and the amount itself is 0.
    const phasedOut = traceOf(
      scalar("eitc", 0, ["eitc_allowed", "eitc_before_eligibility"]),
      judgment("eitc_allowed", "holds"),
      scalar("eitc_before_eligibility", 0, [])
    );
    expect(zeroBecause(syntheticResponse(recordedCall(), { eitc: 0 }, phasedOut), "eitc")).toBeUndefined();
    // A non-zero amount, and a failed gate that is not on the output's path.
    expect(zeroBecause(syntheticResponse(recordedCall(), { eitc: 3923.23 }, unsetSsnTrace()), "eitc")).toBeUndefined();
    const offPath = { ...unsetSsnTrace(), [id("eitc")]: scalar("eitc", 0, ["eitc_before_eligibility"]) };
    expect(zeroBecause(syntheticResponse(recordedCall(), { eitc: 0 }, offPath), "eitc")).toBeUndefined();
  });

  it("leaves a gate that is an output of its own to that output's entry", () => {
    // Queried as an extra output, eitc_allowed carries the same detail itself.
    const options = { ...recordedCall(), extraOutputs: ["eitc_allowed"] };
    const result = syntheticResponse(options, { eitc: 0, eitc_allowed: "not_holds" }, unsetSsnTrace());
    expect(zeroBecause(result, "eitc")).toBeUndefined();
    const gate = result.outputs.find((o) => o.name === "eitc_allowed")!;
    expect(gate.failed_because?.map((f) => f.name)).toEqual(["eitc_identification_requirements_satisfied"]);
  });
});

describe.skipIf(!hasEngine)("real-engine zero_because", () => {
  it("the recorded call: EITC $0 names eitc_allowed and the identification check", async () => {
    const result = await computeProgram(recordedCall());
    expect(numericOutput(result, "eitc")).toBe(0);
    // Every child passes its own gate, so member_checks has nothing to point at.
    const childChecks = result.member_checks?.find((m) => m.member === 2)?.checks ?? [];
    expect(childChecks.find((c) => c.name === "eitc_qualifying_child")?.value).toBe("holds");

    const [gate, ...rest] = zeroBecause(result, "eitc") ?? [];
    expect(rest).toEqual([]);
    expect(gate).toMatchObject({ name: "eitc_allowed", value: "not_holds" });
    expect(gate.failed_because?.map((f) => f.name)).toEqual(["eitc_identification_requirements_satisfied"]);
    expect(gate.requires).toContainEqual({ slot: SSN_ON_RETURN, value: true });
  }, 30_000);

  it("setting the gate's requires at the top level and recomputing once gives $3,923", async () => {
    const first = await computeProgram(recordedCall());
    const [gate] = zeroBecause(first, "eitc")!;
    const memberSlots = new Set((fiit.inputs[fiit.member_entity!] ?? []).map((s) => s.name));
    const set: Facts = {};
    for (const req of gate.requires ?? []) {
      if (req.op) continue; // a threshold test, not a value to set
      expect(memberSlots.has(req.slot)).toBe(false); // a top-level fact, never a member fact
      set[req.slot] = req.value;
    }
    expect(set).toEqual({ [SSN_ON_RETURN]: true });

    const retry = await computeProgram(recordedCall(set));
    expect(Math.round(numericOutput(retry, "eitc") * 100) / 100).toBe(3923.23);
    expect(zeroBecause(retry, "eitc")).toBeUndefined();
  }, 30_000);

  it("childless: names the childless abode and age facts, and one group gives $664", async () => {
    const first = await computeProgram(childlessCall());
    expect(numericOutput(first, "eitc")).toBe(0);
    const [gate] = zeroBecause(first, "eitc")!;
    expect(gate.failed_because?.map((f) => f.name)).toEqual(["eitc_demographic_eligible"]);
    // The nonresident-alien and full-year `or`s hold on their defaults.
    expect(gate.requires_any).toEqual([CHILDLESS_ALTERNATIVES]);

    const group = Object.fromEntries(CHILDLESS_ALTERNATIVES.any_of[1].map((r) => [r.slot, r.value]));
    const retry = await computeProgram(childlessCall(group));
    expect(numericOutput(retry, "eitc")).toBe(664); // oracle fiit-eitc-childless-10k
  }, 30_000);

  it("with children, the computed child count meets the childless `or`", async () => {
    // Another demographic test fails; the childless alternative must not be
    // offered to a filer whose children already count.
    const result = await computeProgram(
      recordedCall({ [SSN_ON_RETURN]: true, taxpayer_is_nonresident_alien_for_any_portion_of_year: true })
    );
    const [gate] = zeroBecause(result, "eitc")!;
    expect(gate.requires_any?.map((alt) => alt.any_of[0][0].slot)).toEqual([
      "taxpayer_is_nonresident_alien_for_any_portion_of_year",
    ]);
  }, 30_000);
});
