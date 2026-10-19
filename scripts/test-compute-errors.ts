/**
 * Compute-path regressions for engine failures.
 *
 * 1. us-fiit senior deduction — "I'm 70 and single, with $100,000 of income
 *    in 2026. How much is my new senior deduction?" returned an empty reply
 *    5/5 times. The senior-deduction MAGI (a TaxUnit rule) adds the §911
 *    exclusion, a Person rule, without a relation aggregator, so the engine
 *    evaluates that Person rule at taxunit:1 and exited with
 *    `missing input individual_is_qualified_individual for taxunit:1`. The
 *    builder now mirrors member 1's member-scope inputs onto non-member query
 *    instances. Expected: $6,000 − 6% × ($100,000 − $75,000) = $4,500
 *    (26 USC 151(d)(5)(C), P.L. 119-21).
 * 2. Engine failures inside compute / lookup_value come back to the model as
 *    {error, hint} tool results. A throw ends the chat stream, and the user
 *    gets an empty reply instead of a retry or an explanation.
 *
 * 3. A fact under members[].facts whose slot has no member scope comes back
 *    as a not_member_input {error, hint}. gpt-6-luna put us-fiit's TaxUnit-only
 *    taxpayer_includes_required_social_security_number_on_return under the
 *    taxpayer's entry; the builder dropped it and EITC came back $0 for
 *    HoH, two kids, $40,000 in 2026. The retry the hint asks for → $3,923.
 *
 * Run: bun run test:compute-errors   (requires local engine or AXIOM_ENGINE_URL)
 */
import assert from "node:assert/strict";

import { getProgram } from "../src/lib/catalog";
import type { InputRecord } from "../src/lib/engine";
import { buildRequest, computeProgram } from "../src/lib/request-builder";
import { tools } from "../src/lib/tools";

const SENIOR_OUTPUTS = [
  "senior_deduction",
  "senior_deduction_amount_per_qualified_individual",
  "senior_deduction_modified_adjusted_gross_income",
];
// The model's compute call from the failing runs: no members.
const MODEL_FACTS = {
  adjusted_gross_income: 100000,
  filing_status: 0,
  taxable_year_begins_before_senior_deduction_termination: true,
};
// What a single 70-year-old filer needs for the deduction to apply.
const QUALIFIED_FILER = {
  taxpayer_is_individual: true,
  is_taxpayer: true,
  age: 70,
  qualified_individual_social_security_number_included_on_return: true,
};
const CALL = { toolCallId: "test", messages: [] };

const fiit = getProgram("us-fiit")!;
assert.ok(fiit, "us-fiit not in catalog");

function inputsAt(inputs: InputRecord[], entityId: string, slot: string) {
  return inputs.filter((i) => i.entity_id === entityId && i.name.endsWith(`#input.${slot}`));
}

function outputValue(result: unknown, name: string) {
  assert.ok(result && typeof result === "object" && !("error" in result), `tool error: ${JSON.stringify(result)}`);
  const output = (result as { outputs: Array<{ name: string; value: unknown }> }).outputs.find(
    (o) => o.name === name
  );
  assert.ok(output, `${name} missing from result`);
  return output.value;
}

function memberInputsMirrored() {
  const synthesized = buildRequest({ program: fiit, period: "2026", facts: { ...MODEL_FACTS, age: 70 } });
  const { inputs } = synthesized.request.dataset;
  assert.equal(inputsAt(inputs, "taxunit:1", "individual_is_qualified_individual").length, 1);
  assert.deepEqual(inputsAt(inputs, "taxunit:1", "age").map((i) => i.value), [{ kind: "decimal", value: "70" }]);
  // A slot in both scopes keeps its single non-member record.
  assert.equal(inputsAt(inputs, "taxunit:1", "filing_status").length, 1);

  const explicit = buildRequest({
    program: fiit,
    period: "2026",
    facts: MODEL_FACTS,
    members: [{ facts: { age: 70 } }, { facts: { age: 40 } }],
  });
  assert.deepEqual(
    inputsAt(explicit.request.dataset.inputs, "taxunit:1", "age").map((i) => i.value),
    [{ kind: "decimal", value: "70" }]
  );
  console.log("ok   builder mirrors member 1's member-scope inputs onto taxunit:1");
}

async function seniorDeduction() {
  // The exact failing call: computes now, $4,500 per qualified individual.
  const modelCall = await tools.compute.execute!(
    { program: "us-fiit", period: "2026", facts: MODEL_FACTS, extra_outputs: SENIOR_OUTPUTS },
    CALL
  );
  assert.equal(outputValue(modelCall, "senior_deduction_amount_per_qualified_individual"), 4500);
  assert.equal(outputValue(modelCall, "senior_deduction_modified_adjusted_gross_income"), 100000);

  // Top-level facts and an explicit member give the same $4,500 deduction.
  const topLevel = await computeProgram({
    program: fiit,
    period: "2026",
    facts: { ...MODEL_FACTS, ...QUALIFIED_FILER },
    extraOutputs: SENIOR_OUTPUTS,
  });
  assert.equal(outputValue(topLevel, "senior_deduction"), 4500);
  const { taxpayer_is_individual, ...personFacts } = QUALIFIED_FILER;
  const member = await computeProgram({
    program: fiit,
    period: "2026",
    facts: { ...MODEL_FACTS, taxpayer_is_individual },
    members: [{ facts: personFacts }],
    extraOutputs: SENIOR_OUTPUTS,
  });
  assert.equal(outputValue(member, "senior_deduction"), 4500);

  // The mirrored §911 inputs feed MAGI: $10,000 excluded → $110,000 MAGI →
  // $6,000 − 6% × $35,000 = $3,900.
  const foreign = await computeProgram({
    program: fiit,
    period: "2026",
    facts: {
      ...MODEL_FACTS,
      ...QUALIFIED_FILER,
      individual_is_qualified_individual: true,
      election_made_for_foreign_earned_income: true,
      foreign_earned_income_of_individual: 10000,
    },
    extraOutputs: SENIOR_OUTPUTS,
  });
  assert.equal(outputValue(foreign, "senior_deduction_modified_adjusted_gross_income"), 110000);
  assert.equal(outputValue(foreign, "senior_deduction"), 3900);

  const lookup = await tools.lookup_value.execute!(
    { program: "us-fiit", output: "senior_deduction", period: "2026", facts: { ...MODEL_FACTS, ...QUALIFIED_FILER } },
    CALL
  );
  assert.ok(!("error" in lookup), `lookup_value error: ${JSON.stringify(lookup)}`);
  assert.equal((lookup as { value: unknown }).value, 4500);
  console.log("ok   us-fiit senior deduction: $4,500 at $100,000 MAGI; $3,900 with $10,000 §911 income");
}

async function engineFailuresAreToolResults() {
  // [label, call, expected error]: an unclassified engine exit falls through
  // to the generic failure; a missing formula version keeps asToolError's
  // more specific no_formula_version limitation.
  const cases: Array<[string, () => PromiseLike<unknown>, RegExp, string?]> = [
    [
      "compute, non-numeric decimal fact",
      () => tools.compute.execute!({ program: "us-fiit", period: "2026", facts: { adjusted_gross_income: "100k" } }, CALL),
      /^calculation failed: axiom-rules-engine/,
    ],
    [
      "compute, period before any formula version",
      () => tools.compute.execute!({ program: "us-fiit", period: "1990", facts: MODEL_FACTS }, CALL),
      /no rule in force for 1990/,
      "no_formula_version",
    ],
    [
      "lookup_value, period before any formula version",
      () =>
        tools.lookup_value.execute!(
          { program: "us-fiit", output: "income_tax_before_credits", period: "1990", facts: MODEL_FACTS },
          CALL
        ),
      /no rule in force for 1990/,
      "no_formula_version",
    ],
  ];
  for (const [label, run, error, kind] of cases) {
    // Must resolve, not reject: a rejection is what ended the stream.
    const result = (await run()) as { error?: unknown; hint?: unknown; kind?: unknown };
    assert.equal(typeof result.error, "string", `${label}: no error field in ${JSON.stringify(result)}`);
    assert.match(result.error as string, error, label);
    assert.equal(result.kind, kind, `${label}: kind`);
    assert.equal(typeof result.hint, "string", `${label}: no hint`);
    console.log(`ok   ${label} → {error, hint}${kind ? ` (${kind})` : ""}`);
  }
}

async function misplacedMemberFact() {
  const ssn = "taxpayer_includes_required_social_security_number_on_return";
  const child = (age: number) => ({
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
  const facts = {
    filing_status: 3,
    adjusted_gross_income: 40000,
    taxable_income: 15850,
    employee_compensation_includible_in_gross_income: 40000,
  };
  const modelCall = { program: "us-fiit", period: "2026", facts, members: [{ facts: { age: 34, [ssn]: true } }, child(8), child(5)] };
  for (const [label, run] of [
    ["compute", () => tools.compute.execute!(modelCall, CALL)],
    ["lookup_value", () => tools.lookup_value.execute!({ ...modelCall, output: "eitc" }, CALL)],
  ] as const) {
    const result = (await run()) as { error?: unknown; kind?: unknown; misplaced?: unknown; hint?: unknown };
    assert.equal(result.kind, "not_member_input", `${label}: ${JSON.stringify(result)}`);
    assert.match(result.error as string, /not Person inputs for us-fiit/);
    assert.deepEqual(result.misplaced, [{ path: `members[0].facts.${ssn}`, slot: ssn, entities: ["TaxUnit"] }]);
    assert.match(result.hint as string, /top-level facts/);
    console.log(`ok   ${label}, TaxUnit fact under members[0] → not_member_input {error, hint}`);
  }

  const retry = await tools.compute.execute!(
    { ...modelCall, facts: { ...facts, [ssn]: true }, members: [{ facts: { age: 34 } }, child(8), child(5)] },
    CALL
  );
  assert.equal(Math.round(outputValue(retry, "eitc") as number), 3923);
  console.log("ok   retry with the fact at the top level: EITC $3,923");
}

async function main() {
  memberInputsMirrored();
  await seniorDeduction();
  await engineFailuresAreToolResults();
  await misplacedMemberFact();
  console.log("\ncompute error tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
