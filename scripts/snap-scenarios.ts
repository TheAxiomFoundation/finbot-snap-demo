/** Input fixtures only. Every result is obtained by running the real engine. */
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getProgram, type CatalogProgram } from "../src/lib/catalog";
import { computeProgram, type Facts, type MemberSpec, type ShapedResult } from "../src/lib/request-builder";

export const SNAP_TEST_PERIOD = "2026-10";
export const CHECKPOINT_DIR = path.resolve(".cache/bbce");

export function checkpoint(name: string, data: unknown): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(path.join(CHECKPOINT_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

/** In CI (REQUIRE_ENGINE=1) a missing engine is a failure, never a silent skip. */
export function skipWithoutEngine(name: string): boolean {
  if (engineAvailable()) return false;
  if (process.env.REQUIRE_ENGINE === "1") {
    console.error(`FAIL ${name}: REQUIRE_ENGINE=1 but no hosted or local engine is available.`);
    process.exit(1);
  }
  console.log(`SKIP ${name}: no hosted or local engine available.`);
  return true;
}

export function engineAvailable(): boolean {
  if (process.env.AXIOM_ENGINE_URL) return true;
  const binary = process.env.AXIOM_RULES_ENGINE_BINARY ?? path.resolve("engine/axiom-rules-engine/target/release/axiom-rules-engine");
  const artifacts = process.env.AXIOM_ARTIFACTS_DIR ?? path.resolve("engine/artifacts");
  try {
    accessSync(binary, constants.X_OK);
    accessSync(path.join(artifacts, "us-ca-snap.compiled.json"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function snapProgram(state: string): CatalogProgram {
  const program = getProgram(`us-${state}-snap`);
  if (!program) throw new Error(`SNAP program missing for ${state}`);
  return program;
}

export function output(result: ShapedResult, name: string): number | string | boolean | null {
  const found = result.outputs.find((o) => o.name === name);
  if (!found) throw new Error(`${result.program}: missing ${name}`);
  return found.value;
}

export function numericOutput(result: ShapedResult, name: string): number {
  const found = output(result, name);
  if (typeof found !== "number" || !Number.isFinite(found)) throw new Error(`${name} is not numeric: ${found}`);
  return found;
}

export function snapScenario(program: CatalogProgram, size: number, earned: number, shelter = 0, ages?: number[]) {
  const allSlots = new Set(Object.values(program.inputs).flat().map((s) => s.name));
  const primarySlots = new Set((program.inputs[program.primary_entity] ?? []).map((s) => s.name));
  const memberSlots = new Set((program.inputs[program.member_entity ?? ""] ?? []).map((s) => s.name));
  const facts: Facts = {};
  const put = (name: string, value: number | boolean) => {
    if (primarySlots.has(name)) facts[name] = value;
  };
  put("household_size", size);
  put("assistance_group_size", size);
  put("budgetary_unit_participant_count", size);
  put("az_utility_allowance_participant_count", size);
  put("snap_gross_monthly_earned_income", earned);
  put("snap_countable_earned_income", earned);
  put("snap_total_monthly_unearned_income", 0);
  put("other_unearned_income", 0);
  put("snap_unearned_income", 0);
  put("household_shelter_costs_incurred", shelter);
  put("monthly_allowable_shelter_costs", shelter);
  for (const slot of Object.values(program.inputs).flat()) {
    if (primarySlots.has(slot.name) && slot.dtype === "bool" && /elderly|disabled/.test(slot.name)) facts[slot.name] = false;
  }
  const members: MemberSpec[] = Array.from({ length: size }, (_, i) => {
    const memberFacts: Facts = {};
    const age = ages?.[i] ?? 35;
    if (memberSlots.has("member_age")) memberFacts.member_age = age;
    if (memberSlots.has("member_is_us_citizen")) memberFacts.member_is_us_citizen = true;
    if (memberSlots.has("snap_member_is_elderly_or_disabled")) memberFacts.snap_member_is_elderly_or_disabled = false;
    return { facts: memberFacts };
  });
  if (!allSlots.has("household_size")) throw new Error(`${program.slug}: no household size input`);
  return { facts, members };
}

/** Query the encoded 100% limit rather than recreating a policy table. */
export async function encodedFplMonthly(size: number): Promise<number> {
  const program = snapProgram("ca");
  const result = await computeProgram({
    program,
    period: SNAP_TEST_PERIOD,
    ...snapScenario(program, size, 0),
    outputsOverride: ["snap_net_income_limit_100_percent_fpl_48_states_dc"],
    mode: "explain",
  });
  return numericOutput(result, "snap_net_income_limit_100_percent_fpl_48_states_dc");
}

export const STARTER_FIXTURES = [
  { state: "ca", expectedBenefit: 254 },
] as const;

export function starterScenario(state: string) {
  const program = snapProgram(state);
  const scenario = snapScenario(program, 3, 3400, 1500, [32, 8, 5]);
  const slots = new Set((program.inputs[program.primary_entity] ?? []).map((s) => s.name));
  for (const name of [
    "household_has_heating_and_cooling_costs_separate_from_rent_or_mortgage",
    "household_incurred_or_anticipated_heating_or_cooling_costs_separate_from_rent_or_mortgage",
  ]) {
    if (slots.has(name)) scenario.facts[name] = true;
  }
  return { program, period: SNAP_TEST_PERIOD, ...scenario };
}
