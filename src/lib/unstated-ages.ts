/**
 * Ages nobody stated (the catalog's `age_tests`).
 *
 * An unstated age is 0 (scripts/generate-catalog.ts SCENARIO_AGE), and no
 * default age is neutral: 0 passes every "younger than N" test. In
 * us-ca/co/ny-snap two of those tests are work-rule exemptions —
 * snap_member_general_work_requirement_exempt (younger than 16, 7 CFR
 * 273.7(b)(1)(i)) and snap_member_abawd_exception_applies (under 18, 7 USC
 * 2015(o)(3)(A)). A single adult with $300 unearned income, $600 rent and 4
 * countable ABAWD months got $298, where an adult aged 18 to 59 gets $0; one
 * who quit a job without good cause got $298, where one aged 16 to 59 gets
 * $0. The old fixture default (60) was wrong the other way.
 *
 * So when a rule that held for member 1 passed such a test on an age slot
 * nobody stated, the compute runs once more at the youngest age that passes
 * none of them. If a published output changes, the applied report carries
 * both results with the ages each covers, and the reply has to say the
 * answer depends on the age.
 */
import type { DerivedTraceNode } from "./engine";
import type { AgeTest, CatalogOutput, CatalogProgram } from "./catalog";

/** A member 1 age slot the caller didn't state, with the rules that held
 *  for member 1 and whose "younger than" tests the slot's default passed
 *  (another branch of such a rule may hold too; the probe tells). */
export interface UnstatedAge {
  slot: string;
  default: number;
  passed: Array<{ rule: string; source: string | null; tests: AgeTest[] }>;
  /** The youngest age that passes none of `passed`; null when an older test
   *  of the same rules would hold there too (no age escapes them). */
  probe: number | null;
}

const meets = (value: number, t: AgeTest) =>
  t.op === "lt" ? value < t.value : t.op === "lte" ? value <= t.value : t.op === "gt" ? value > t.value : value >= t.value;

/** Where `t` changes its result: it holds below (lt/lte) or from (gt/gte)
 *  this age. */
const boundary = (t: AgeTest) => (t.op === "lt" || t.op === "gte" ? t.value : t.value + 1);

export const describeTest = (t: AgeTest) =>
  `${t.slot} ${{ lt: "<", lte: "<=", gt: ">", gte: ">=" }[t.op]} ${t.value}`;

/** Judgment names that held in `trace`. */
function heldRules(trace: Record<string, DerivedTraceNode>): Set<string> {
  return new Set(Object.values(trace).filter((n) => n.kind === "judgment" && n.outcome === "holds").map((n) => n.name));
}

/** Rule names `trace` evaluated. */
export function tracedRules(trace: Record<string, DerivedTraceNode>): Set<string> {
  return new Set(Object.values(trace).map((n) => n.name));
}

/** The program's rules with age tests, by name. */
function ageTestRules(program: CatalogProgram): CatalogOutput[] {
  return program.outputs.filter((o) => o.age_tests?.length);
}

/** Age slots member 1 has no stated value for whose default passed a
 *  "younger than" test of a rule that held for member 1 in `trace`. */
export function unstatedAges(
  program: CatalogProgram,
  trace: Record<string, DerivedTraceNode>,
  stated: (slot: string) => boolean,
  defaultOf: (slot: string) => unknown
): UnstatedAge[] {
  const held = heldRules(trace);
  const bySlot = new Map<string, UnstatedAge>();
  const older = new Map<string, AgeTest[]>();
  for (const output of ageTestRules(program)) {
    if (!held.has(output.name)) continue;
    for (const test of output.age_tests!) {
      const value = defaultOf(test.slot);
      if (stated(test.slot) || typeof value !== "number") continue;
      if (test.op === "gt" || test.op === "gte") {
        older.set(test.slot, [...(older.get(test.slot) ?? []), test]);
        continue;
      }
      if (!meets(value, test)) continue;
      const entry = bySlot.get(test.slot) ?? { slot: test.slot, default: value, passed: [], probe: null };
      const rule = entry.passed.find((p) => p.rule === output.name);
      if (rule) rule.tests.push(test);
      else entry.passed.push({ rule: output.name, source: output.source, tests: [test] });
      bySlot.set(test.slot, entry);
    }
  }
  for (const entry of bySlot.values()) {
    const probe = Math.max(...entry.passed.flatMap((p) => p.tests.map(boundary)));
    entry.probe = (older.get(entry.slot) ?? []).some((t) => meets(probe, t)) ? null : probe;
  }
  return [...bySlot.values()];
}

/** The ages around `value` for which every test of `slot` in the named
 *  rules gives the same result as at `value`: `[from, to]`, `to` null when
 *  no test changes above it. With `rules` the ones a run traced for the
 *  member, any age in the range takes the same path through them and
 *  computes the same. A rule read only inside a relation aggregation is not
 *  in that trace, so its tests are not counted. */
export function ageRange(
  program: CatalogProgram,
  slot: string,
  rules: Set<string>,
  value: number,
  floor: number
): { from: number; to: number | null } {
  const bounds = ageTestRules(program)
    .filter((o) => rules.has(o.name))
    .flatMap((o) => o.age_tests!.filter((t) => t.slot === slot).map(boundary));
  const from = Math.max(floor, ...bounds.filter((b) => b <= value));
  const above = bounds.filter((b) => b > value);
  return { from, to: above.length ? Math.min(...above) - 1 : null };
}

export const rangeLabel = (r: { from: number; to: number | null }) =>
  r.to === null ? `${r.from} or older` : r.from === r.to ? `${r.from}` : `${r.from} to ${r.to}`;

export type OutputValues = Record<string, number | boolean | string | null>;

/** Applied-report note when a compute at member 1's probe age changed a
 *  published output. The model sees which tests the unstated age passed and
 *  both results; the user has to hear that the answer depends on the age. */
export function unstatedAgeNote(
  entry: UnstatedAge,
  primary: string,
  results: Array<{ ages: string; outputs: OutputValues }>
): string {
  const tests = entry.passed
    .map((p) => `${p.rule} (${p.tests.map(describeTest).join(", ")}${p.source ? `; ${p.source}` : ""})`)
    .join(", ");
  const show = (outputs: OutputValues) => Object.entries(outputs).map(([k, v]) => `${k} ${v}`).join(", ");
  const [stated, probed] = results;
  return (
    `NOTE: member 1's ${entry.slot} was not stated, so it is ${entry.default}, and ${entry.default} passed these age tests: ${tests}. ` +
    `This result holds for ${entry.slot} ${stated.ages}; for ${entry.slot} ${probed.ages} it is ${show(probed.outputs)} (applied.unstated_ages). ` +
    `If member 1 is an adult, the ${stated.ages} result is not theirs: don't present ${primary} ${stated.outputs[primary]} as their amount. ` +
    `Give the ${probed.ages} result, say the amount depends on their age, and ask their age. ` +
    `Don't quote a result for any other age; compute it once the age is known.`
  );
}
