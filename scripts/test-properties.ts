/** Real-engine properties. No model calls and no TypeScript policy calculator.
 * fast-check minimizes failures; the checkpoint records the replay seed/path,
 * minimized inputs and actual outputs. Known gaps (AZ/MA/AL/TN gates for I1,
 * the withheld CO default for I4) are recorded as intended violations.
 */
import * as fc from "fast-check";
import { getCatalog } from "../src/lib/catalog";
import { fact, runCompiled } from "../src/lib/engine";
import { buildRequest, computeProgram, shapeResult } from "../src/lib/request-builder";
import {
  checkpoint, CHECKPOINT_DIR, encodedFplMonthly, engineAvailable,
  numericOutput, output, SNAP_TEST_PERIOD, snapProgram, snapScenario,
} from "./snap-scenarios";

const SEED = 20261007;
const RUNS = 60;
const states = getCatalog().programs.filter((p) => p.program_id === "snap").map((p) => p.slug.slice(3, 5));
const results: Array<Record<string, unknown>> = [];
const intendedViolations: Array<Record<string, unknown>> = [];
const fpl = new Map<number, number>();
const save = () => checkpoint("properties", {
  period: SNAP_TEST_PERIOD, seed: SEED, requestedRuns: RUNS, results, intendedViolations,
  limitations: [
    "I4 covers CA 1–2 person households; I4b allows CA households of three or more to be denied only when their computed benefit is zero.",
    "CO automatic categorical eligibility is withheld because the input bypasses an encoded IPV bar; recorded as an intended I4 violation.",
    "AZ, MA, AL and TN unconditional eligibility gates are intended I1 exclusions, probed through the engine directly; the assistant cannot set them.",
  ],
});

type Observation = { pass: boolean; [key: string]: unknown };

async function property<T>(name: string, arbitrary: fc.Arbitrary<T>, evaluate: (sample: T) => Promise<Observation>) {
  const details = await fc.check(fc.asyncProperty(arbitrary, async (sample) => (await evaluate(sample)).pass), {
    seed: SEED, numRuns: RUNS,
  });
  if (details.failed) {
    const minimized = details.counterexample?.[0];
    let observed: Observation | undefined;
    if (minimized !== undefined) {
      try { observed = await evaluate(minimized); }
      catch (err) { observed = { pass: false, error: (err as Error).message }; }
    }
    results.push({ name, status: "failed", numRuns: details.numRuns, numShrinks: details.numShrinks,
      counterexample: minimized, counterexamplePath: details.counterexamplePath,
      observation: observed, error: details.errorInstance instanceof Error ? details.errorInstance.message : String(details.errorInstance ?? "") });
    console.log(`FAIL ${name}: minimized after ${details.numShrinks} shrinks, ${JSON.stringify(minimized)}`);
    console.log(`     ${JSON.stringify(observed)}; seed ${SEED}, replay path ${details.counterexamplePath}`);
  } else {
    results.push({ name, status: "passed", numRuns: details.numRuns });
    console.log(`ok   ${name}: ${details.numRuns} generated cases`);
  }
  save();
}

async function compute(state: string, size: number, earned: number, shelter = 0) {
  const program = snapProgram(state);
  return computeProgram({ program, period: SNAP_TEST_PERIOD,
    ...snapScenario(program, size, earned, shelter), extraOutputs: ["snap_maximum_allotment"], mode: "explain" });
}

async function probeIntendedI1Violations() {
  for (const [state, gate] of [
    ["az", "na_budgetary_unit_is_eligible"],
    ["ma", "snap_household_is_categorically_eligible"],
    ["al", "household_is_categorically_eligible"],
    ["tn", "household_is_categorically_eligible"],
  ]) {
    const program = snapProgram(state);
    const earned = Math.ceil(fpl.get(1)! * 3.07);
    // Artifact probe only: build the allowed request, then toggle the blocked
    // gate in the raw engine dataset to demonstrate why assistant access is
    // forbidden. This is deliberately outside the model's tool interface.
    const built = buildRequest({ program, period: SNAP_TEST_PERIOD,
      ...snapScenario(program, 1, earned), mode: "explain" });
    const input = built.request.dataset.inputs.find((i) => i.entity === program.primary_entity && i.name.endsWith(`#input.${gate}`));
    if (!input) throw new Error(`missing intended-violation gate: ${state}/${gate}`);
    input.value = fact(true, "bool");
    const response = await runCompiled(program.slug, built.request);
    const result = shapeResult(program, built, response);
    const eligible = output(result, "snap_eligible");
    const benefit = numericOutput(result, "snap_benefit");
    intendedViolations.push({ state: state.toUpperCase(), gate, gateValue: true, size: 1, earned,
      percent: 307, eligible, benefit, status: eligible === "holds" ? "intended I1 violation" : "not reproduced" });
    console.log(`known I1 exclusion ${state.toUpperCase()}: ${gate}=true at 307% → ${eligible}, $${benefit}`);
    save();
  }
}

async function main() {
  if (!engineAvailable()) {
    console.log("SKIP test:properties: set AXIOM_ENGINE_URL, or provide a local executable AXIOM_RULES_ENGINE_BINARY and AXIOM_ARTIFACTS_DIR with compiled artifacts.");
    checkpoint("properties", { status: "skipped", reason: "No hosted or local engine available" });
    return;
  }
  save();
  for (let size = 1; size <= 8; size++) fpl.set(size, await encodedFplMonthly(size));
  const sizeArbitrary = fc.integer({ min: 1, max: 8 });
  for (const state of ["ca", "co", "nc"]) {
    await property(`I1 ${state.toUpperCase()}: above 200% encoded FPL denied`, fc.record({
      size: sizeArbitrary, percent: fc.integer({ min: 201, max: 400 }), shelter: fc.integer({ min: 0, max: 5000 }),
    }), async ({ size, percent, shelter }) => {
      const earned = Math.ceil(fpl.get(size)! * percent / 100);
      const result = await compute(state, size, earned, shelter);
      const eligible = output(result, "snap_eligible");
      return { pass: eligible === "not_holds", state, size, earned, shelter, eligible };
    });
  }
  await probeIntendedI1Violations();

  const generalModel = { state: fc.constantFrom(...states), size: sizeArbitrary,
    earned: fc.integer({ min: 0, max: 20000 }), shelter: fc.integer({ min: 0, max: 5000 }) };
  const general = fc.record(generalModel);
  await property("I2 benefit ≤ engine maximum allotment", general, async ({ state, size, earned, shelter }) => {
    const result = await compute(state, size, earned, shelter);
    const benefit = numericOutput(result, "snap_benefit");
    const maximum = numericOutput(result, "snap_maximum_allotment");
    return { pass: benefit >= 0 && benefit <= maximum, state, size, earned, shelter, benefit, maximum };
  });
  await property("I3 benefit non-increasing in earned income", fc.record({ ...generalModel,
    increase: fc.integer({ min: 1, max: 5000 }) }), async ({ state, size, earned, shelter, increase }) => {
    const lower = await compute(state, size, earned, shelter);
    const higher = await compute(state, size, earned + increase, shelter);
    const lowerBenefit = numericOutput(lower, "snap_benefit");
    const higherBenefit = numericOutput(higher, "snap_benefit");
    return { pass: higherBenefit <= lowerBenefit, state, size, earned, increase, shelter, lowerBenefit, higherBenefit };
  });

  // I4 (BBCE fix). One- and two-person categorically eligible households get the
  // minimum benefit, so between 130% and 200% FPL they must be eligible. Larger
  // households can still be denied, but only when their computed benefit is $0
  // (the counterexample fast-check found: CA, 3 people, 159% FPL, $0).
  await property("I4 CA: 1–2 people at 130–200% FPL eligible at default inputs", fc.record({
    size: fc.integer({ min: 1, max: 2 }), percent: fc.integer({ min: 131, max: 199 }),
    shelter: fc.integer({ min: 0, max: 5000 }),
  }), async ({ size, percent, shelter }) => {
    const earned = Math.ceil(fpl.get(size)! * percent / 100);
    const result = await compute("ca", size, earned, shelter);
    const eligible = output(result, "snap_eligible");
    const benefit = numericOutput(result, "snap_benefit");
    return { pass: eligible === "holds" && benefit > 0, size, earned, shelter, eligible, benefit };
  });
  await property("I4b CA: 3+ people at 130–200% FPL denied only with a $0 benefit", fc.record({
    size: fc.integer({ min: 3, max: 8 }), percent: fc.integer({ min: 131, max: 199 }),
    shelter: fc.integer({ min: 0, max: 5000 }),
  }), async ({ size, percent, shelter }) => {
    const earned = Math.ceil(fpl.get(size)! * percent / 100);
    const result = await compute("ca", size, earned, shelter);
    const eligible = output(result, "snap_eligible");
    const benefit = numericOutput(result, "snap_benefit");
    return { pass: (eligible === "holds") === (benefit > 0), size, earned, shelter, eligible, benefit };
  });
  {
    // Intended violation, recorded rather than asserted: the Colorado BBCE input
    // also bypasses the encoded IPV bar (10 CCR 2506-1 4.206(C)(2)(c); 7 CFR
    // 273.2(j)(2)(vii)(A)), so the app does not default it and Colorado BBCE
    // households get $0 at default inputs until the encoding is repaired.
    const earned = Math.ceil(fpl.get(3)! * 1.5);
    const result = await compute("co", 3, earned);
    const eligible = output(result, "snap_eligible");
    const benefit = numericOutput(result, "snap_benefit");
    intendedViolations.push({ state: "CO", invariant: "I4", size: 3, earned, percent: 150, eligible, benefit,
      status: eligible === "not_holds" ? "intended I4 violation: default withheld (IPV bar bypass)" : "not reproduced" });
    console.log(`known I4 gap CO: 3 people at 150% FPL → ${eligible}, $${benefit} (default withheld)`);
    save();
  }

  await property("I5 deterministic outputs", general, async ({ state, size, earned, shelter }) => {
    const first = await compute(state, size, earned, shelter);
    const second = await compute(state, size, earned, shelter);
    return { pass: JSON.stringify(first.outputs) === JSON.stringify(second.outputs), state, size, earned, shelter,
      first: first.outputs.map(({ name, value }) => ({ name, value })), second: second.outputs.map(({ name, value }) => ({ name, value })) };
  });
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`\nproperties: ${results.length - failed}/${results.length} passed; ${failed} failed. Checkpoint: ${CHECKPOINT_DIR}/properties.json`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  results.push({ name: "runner", status: "failed", error: (err as Error).message });
  save();
  console.error(err);
  process.exitCode = 1;
});
