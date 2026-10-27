import { beforeEach, describe, expect, it, vi } from "vitest";

import { getProgram } from "./catalog";
import { runCompiled, type ExecutionRequest } from "./engine";
import { computeProgram, type Facts } from "./request-builder";
import { engineAvailable } from "../../scripts/snap-scenarios";

// The real engine, counted: how many runs the earlier-formula attribution
// adds to a compute, and what a failed one leaves behind.
vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return { ...actual, runCompiled: vi.fn(actual.runCompiled) };
});

const CHECK = "snap_member_citizenship_or_alien_status_eligible";
const fl = getProgram("us-fl-snap")!;
const hasEngine = engineAvailable();
const REFUGEE: Facts = { member_is_refugee: true, member_is_us_citizen: false };
const compute = (members: Facts[]) =>
  computeProgram({ program: fl, period: "2026-10", facts: { household_size: members.length }, members: members.map((facts) => ({ facts })) });
const calls = () => vi.mocked(runCompiled).mock.calls as Array<[string, ExecutionRequest, { signal?: AbortSignal }?]>;
/** The runs made in June 2025, the month the pre-amendment formula ends. */
const earlierRuns = () => calls().filter(([, request]) => request.queries.every((q) => q.period.start === "2025-06-01"));

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!hasEngine)("earlier-formula runs", () => {
  it("make one run per failed rule, whatever the household size, with a timeout", async () => {
    await compute([REFUGEE]);
    expect(earlierRuns()).toHaveLength(1);
    vi.clearAllMocks();

    const six = await compute(Array(6).fill(REFUGEE));
    const [[, request, options]] = earlierRuns();
    expect(earlierRuns()).toHaveLength(1);
    expect(request.queries.map((q) => [q.entity_id, q.outputs])).toEqual(
      [1, 2, 3, 4, 5, 6].map((m) => [`person:${m}`, [`us:regulations/7-cfr/273/4#${CHECK}`]])
    );
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(six.member_checks?.slice(1).every((m) => m.same_as === 1)).toBe(true);
    vi.clearAllMocks();

    // A ground the earlier formula takes with no status adds one recheck.
    await compute(Array(6).fill({ ...REFUGEE, member_is_under_age_eighteen: true }));
    expect(earlierRuns()).toHaveLength(2);
    vi.clearAllMocks();

    await compute([{ member_is_us_citizen: true }]);
    expect(earlierRuns()).toHaveLength(0);
  }, 30_000);

  it("run alongside the unstated-age probes, not after them", async () => {
    // A California citizen with 4 countable ABAWD months and no stated age
    // gets an age probe; the refugee beside them gets an earlier-formula run.
    const actual = (await vi.importActual<typeof import("./engine")>("./engine")).runCompiled;
    const events: string[] = [];
    let call = 0;
    vi.mocked(runCompiled).mockImplementation(async (slug, request, options) => {
      const n = call++;
      if (request.queries.every((q) => q.period.start === "2025-06-01")) events.push("earlier");
      else if (n > 0) {
        events.push("probe start");
        await new Promise((resolve) => setTimeout(resolve, 200));
        events.push("probe end");
      }
      return actual(slug, request, options);
    });
    const ca = getProgram("us-ca-snap")!;
    const result = await computeProgram({
      program: ca,
      period: "2026-10",
      facts: { household_size: 2, snap_total_monthly_unearned_income: 300, household_shelter_costs_incurred: 600 },
      members: [{ facts: { snap_abawd_countable_months_in_three_year_period: 4 } }, { facts: REFUGEE }],
    });
    expect(result.applied.unstated_ages).toHaveLength(1);
    expect(JSON.stringify(result)).toContain('"changed_outcome":true');
    expect(events).toEqual(["probe start", "earlier", "probe end"]);
  }, 30_000);

  it("leave the compute intact and claim nothing when the run fails or times out", async () => {
    const actual = (await vi.importActual<typeof import("./engine")>("./engine")).runCompiled;
    const expected = await compute([REFUGEE, { member_is_us_citizen: false }]);
    vi.mocked(runCompiled).mockImplementation(async (slug, request, options) => {
      if (request.queries.every((q) => q.period.start === "2025-06-01")) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return actual(slug, request, options);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await compute([REFUGEE, { member_is_us_citizen: false }]);
    expect(errors).toHaveBeenCalledWith("[finbot] earlier-formula run failed:", expect.anything(), "program:", "us-fl-snap", "rule:", CHECK, "period:", "2025-06");
    errors.mockRestore();
    expect(result.outputs.map((o) => [o.name, o.value])).toEqual(expected.outputs.map((o) => [o.name, o.value]));
    const json = JSON.stringify(result);
    expect(json).toContain('"amended_by"');
    for (const field of ["changed_outcome", "changed_for_members", "unchanged_for_members", '"earlier"']) expect(json).not.toContain(field);
    // With no earlier answer the two members' equal checks stay merged.
    expect(result.member_checks?.[1]).toEqual({ member: 2, same_as: 1 });
  }, 30_000);
});
