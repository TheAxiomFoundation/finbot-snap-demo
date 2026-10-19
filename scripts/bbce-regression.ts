/** Eligibility regressions, separate from the frozen PolicyEngine dollar oracle.
 * Expectations use the program's encoded FY2026 income limits. Colorado's
 * default remains a denial because the proposed automatic categorical flag
 * bypasses its encoded IPV exclusion. That known gap must not be called fixed.
 */
import assert from "node:assert/strict";
import { computeProgram } from "../src/lib/request-builder";
import { BBCE_STARTERS } from "../src/lib/starters";
import {
  checkpoint, encodedFplMonthly, numericOutput, output,
  SNAP_TEST_PERIOD, snapProgram, snapScenario, starterScenario, STARTER_FIXTURES,
} from "./snap-scenarios";

export async function runBbceRegressions(checkpointName: string): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  const starterRows: Array<Record<string, unknown>> = [];
  let failures = 0;
  const save = () => checkpoint(checkpointName, { period: SNAP_TEST_PERIOD, rows, starters: starterRows, failures });
  save();

  for (const size of [1, 3]) {
    const fpl = await encodedFplMonthly(size);
    for (const state of ["ca", "co", "ny", "nc"]) {
      const program = snapProgram(state);
      for (const percent of [145, 175, 195, 207]) {
        const earned = Math.ceil(fpl * percent / 100);
        // High shelter costs keep the 3+ person positive-benefit condition
        // from obscuring the categorical income gate below 200%.
        const scenario = snapScenario(program, size, earned, 3000);
        const expected = state === "co" || percent > (state === "ny" ? 150 : 200) ? "not_holds" : "holds";
        try {
          const result = await computeProgram({ program, period: SNAP_TEST_PERIOD, ...scenario, mode: "explain" });
          const actual = output(result, "snap_eligible");
          const benefit = numericOutput(result, "snap_benefit");
          rows.push({ state: state.toUpperCase(), size, percent, encodedFplMonthly: fpl, earned, shelter: 3000, expected, actual, benefit,
            ...(state === "co" ? { limitation: "Default BBCE withheld: categorical input bypasses IPV bar" } : {}) });
          assert.equal(actual, expected, `${state}, size ${size}, ${percent}% encoded FPL`);
          console.log(`ok   bbce-${state}-${size}-${percent}: ${actual}, $${benefit}${state === "co" ? " (known default BBCE gap)" : ""}`);
        } catch (err) {
          failures++;
          const error = (err as Error).message;
          if (!rows.at(-1) || rows.at(-1)?.state !== state.toUpperCase() || rows.at(-1)?.percent !== percent) rows.push({ state: state.toUpperCase(), size, percent, expected, error });
          console.log(`FAIL bbce-${state}-${size}-${percent}: ${error}`);
        }
        save();
      }
    }
  }

  for (const [i, fixture] of STARTER_FIXTURES.entries()) {
    try {
      const result = await computeProgram(starterScenario(fixture.state));
      const benefit = numericOutput(result, "snap_benefit");
      const eligible = output(result, "snap_eligible");
      starterRows.push({ state: fixture.state.toUpperCase(), prompt: BBCE_STARTERS[i], expectedBenefit: fixture.expectedBenefit, benefit, eligible });
      assert.equal(eligible, "holds");
      assert.equal(benefit, fixture.expectedBenefit);
      console.log(`ok   bbce-${fixture.state}-starter: $${benefit}, eligible (FY2026 standards)`);
    } catch (err) {
      failures++;
      console.log(`FAIL bbce-${fixture.state}-starter: ${(err as Error).message}`);
    }
    save();
  }
  return failures;
}
