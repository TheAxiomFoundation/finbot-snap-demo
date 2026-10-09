import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { getProgram } from "./catalog";
import { buildRequest } from "./request-builder";

const HISTORICAL_SLOT = "member_is_trafficking_victim_or_qualifying_family_member";

describe("historical formula catalog coverage", () => {
  it("keeps pre-July-2025 citizenship inputs in the Person scope with their type and reachability", () => {
    const program = getProgram("us-ny-snap")!;
    expect(program.inputs.Person.find((slot) => slot.name === HISTORICAL_SLOT))
      .toMatchObject({ dtype: "bool", default: false });
    expect(program.inputs.Person.find((slot) => slot.name === HISTORICAL_SLOT)?.aux)
      .not.toBe(true);
  });

  it("preserves supplied historical facts for every generated past period and boolean value", () => {
    fc.assert(fc.property(fc.integer({ min: 2018, max: 2025 }), fc.integer({ min: 1, max: 12 }), fc.boolean(), (year, month, value) => {
      const period = `${year}-${month.toString().padStart(2, "0")}`;
      const built = buildRequest({
        program: getProgram("us-ny-snap")!, period,
        members: [{ facts: { [HISTORICAL_SLOT]: value } }],
      });
      const inputs = built.request.dataset.inputs.filter((input) => input.name.endsWith(`#input.${HISTORICAL_SLOT}`));
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every((input) => input.entity === "Person" && input.value.kind === "bool" && input.value.value === value)).toBe(true);
    }), { seed: 20261009, numRuns: 200 });
  });
});
