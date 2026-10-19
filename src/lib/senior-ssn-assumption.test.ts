import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import { buildRequest, computeProgram, type MemberSpec } from "./request-builder";
import { engineAvailable, memberCheck, numericOutput, output } from "../../scripts/snap-scenarios";

// 26 USC 151(d)(5)(C): the senior deduction needs the taxpayer to be an
// individual and the qualified individual's SSN on the return. In 1 of 10
// live gpt-6-luna runs of "I'm 70 and single, with $100,000 of income in
// 2026. How much is my new senior deduction?" the model set the age but
// neither fact, did not recompute, and headlined "$0".
const SSN = "qualified_individual_social_security_number_included_on_return";
const CHECK = "senior_deduction_qualified_individual";
const fiit = getProgram("us-fiit")!;
// The run-10 compute, as the model sent it.
const RUN_10 = {
  program: fiit,
  period: "2026",
  facts: { adjusted_gross_income: 100000, taxpayer_married_at_close_of_taxable_year: false },
  members: [{ facts: { age: 70, individual_age_at_close_of_calendar_year: 70, is_taxpayer: true } }] as MemberSpec[],
};
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

function ssnRecords(built: ReturnType<typeof buildRequest>, entityId: string) {
  return built.request.dataset.inputs.filter((i) => i.name.endsWith(`#input.${SSN}`) && i.entity_id === entityId);
}

describe("senior-deduction prerequisites the user never mentions", () => {
  it("defaults taxpayer_is_individual to true as a disclosed overlay default", () => {
    const slot = fiit.inputs.TaxUnit.find((s) => s.name === "taxpayer_is_individual")!;
    expect(slot).toMatchObject({ default: true, default_source: "overlay" });
    expect(buildRequest(RUN_10).applied.overlay_defaults_in_effect?.taxpayer_is_individual).toBe(true);
  });

  it("assumes the SSN is on the return for every member with no SSN fact", () => {
    const built = buildRequest({ ...RUN_10, members: [...RUN_10.members, { facts: { age: 8 } }] });
    expect(ssnRecords(built, "person:1").every((i) => i.value.value === true)).toBe(true);
    expect(ssnRecords(built, "person:2").every((i) => i.value.value === true)).toBe(true);
    // Before the compute every assumed member is listed; shapeResult narrows it.
    expect(built.applied.assumed_facts).toEqual([expect.objectContaining({ slot: SSN, value: true, members: [1, 2] })]);
  });

  it("keeps a stated SSN fact, and an SSN fact stated false anywhere turns the assumption off", () => {
    const stated = buildRequest({ ...RUN_10, members: [{ facts: { ...RUN_10.members[0].facts, [SSN]: false } }] });
    expect(ssnRecords(stated, "person:1").every((i) => i.value.value === false)).toBe(true);
    expect(stated.applied.assumed_facts).toBeUndefined();

    const itin = buildRequest({ ...RUN_10, facts: { ...RUN_10.facts, taxpayer_includes_required_social_security_number_on_return: false } });
    expect(ssnRecords(itin, "person:1").every((i) => i.value.value === false)).toBe(true);
    expect(itin.applied.assumed_facts).toBeUndefined();
  });

  it("assumes nothing outside us-fiit", () => {
    const snap = buildRequest({ program: getProgram("us-fl-snap")!, facts: { household_size: 1 } });
    expect(snap.applied.assumed_facts?.map((a) => a.slot)).toEqual(["member_is_us_citizen"]);
  });
});

describe.skipIf(!hasEngine)("real-engine senior deduction from the run-10 facts", () => {
  it("computes $4,500 and discloses the SSN assumption", async () => {
    const result = await computeProgram({ ...RUN_10, extraOutputs: ["senior_deduction", "senior_deduction_eligible"] });
    expect(output(result, "senior_deduction_eligible")).toBe("holds");
    expect(memberCheck(result, 1, CHECK).value).toBe("holds");
    // $6,000 − 6% × ($100,000 − $75,000) = $4,500 (26 USC 151(d)(5)(C)(iii)).
    expect(numericOutput(result, "senior_deduction")).toBe(4500);
    expect(result.applied.assumed_facts).toEqual([
      expect.objectContaining({ slot: SSN, value: true, members: [1] }),
    ]);
    expect(result.applied.overlay_defaults_in_effect?.taxpayer_is_individual).toBe(true);
  }, 30_000);

  it("gives $0 without a disclosure when the user says the SSN is not on the return", async () => {
    const result = await computeProgram({
      ...RUN_10,
      members: [{ facts: { ...RUN_10.members[0].facts, [SSN]: false } }],
      extraOutputs: ["senior_deduction"],
    });
    expect(memberCheck(result, 1, CHECK).value).toBe("not_holds");
    expect(numericOutput(result, "senior_deduction")).toBe(0);
    expect(result.applied.assumed_facts).toBeUndefined();
  }, 30_000);

  it("discloses the assumption only for members whose senior check holds", async () => {
    // A 40-year-old: the assumption changes nothing, so it isn't disclosed.
    const younger = await computeProgram({
      ...RUN_10,
      members: [{ facts: { age: 40, is_taxpayer: true } }],
      extraOutputs: ["senior_deduction"],
    });
    expect(numericOutput(younger, "senior_deduction")).toBe(0);
    expect(younger.applied.assumed_facts).toBeUndefined();

    // A 70-year-old taxpayer with an 8-year-old child: only the taxpayer.
    const withChild = await computeProgram({
      ...RUN_10,
      members: [...RUN_10.members, { facts: { age: 8 } }],
      extraOutputs: ["senior_deduction"],
    });
    expect(numericOutput(withChild, "senior_deduction")).toBe(4500);
    expect(withChild.applied.assumed_facts).toEqual([expect.objectContaining({ slot: SSN, members: [1] })]);
  }, 30_000);

  it("keeps the disclosure on the lookup path, which runs no member checks", async () => {
    const result = await computeProgram({ ...RUN_10, outputsOverride: ["senior_deduction"] });
    expect(numericOutput(result, "senior_deduction")).toBe(4500);
    expect(result.member_checks).toBeUndefined();
    expect(result.applied.assumed_facts).toEqual([expect.objectContaining({ slot: SSN, members: [1] })]);
  }, 30_000);
});
