import { describe, expect, it } from "vitest";

import { getCatalog, getProgram } from "./catalog";
import { describeProgramPayload } from "./describe";
import { computeProgram, type Facts, type MemberSpec } from "./request-builder";
import { engineAvailable, numericOutput, output } from "../../scripts/snap-scenarios";

// The CA, CO and NY SNAP fixtures' first case is a 60-year-old, and the
// generator copied that age into member_age's default. describe showed
// `member_age:integer=60`, and gpt-6-luna replied "I assumed you're a U.S.
// citizen and used the default age of 60". 7 CFR 271.2 makes a member 60 or
// older elderly; 273.7(b)(1)(i) exempts "a person 60 years of age or older"
// from the work requirements. PR #12 zeroed this default once.
const AGE_SLOT = /(^|_)age(_|$)/;
const hasEngine = engineAvailable();
if (process.env.REQUIRE_ENGINE === "1" && !hasEngine) {
  throw new Error("REQUIRE_ENGINE=1 but no hosted or local engine is available");
}

describe("age defaults", () => {
  it("gives no age slot a non-zero default", () => {
    const nonZero = getCatalog().programs.flatMap((p) =>
      Object.values(p.inputs)
        .flat()
        .filter((s) => AGE_SLOT.test(s.name) && (s.dtype === "integer" || s.dtype === "decimal") && s.default !== 0)
        .map((s) => `${p.slug}:${s.name}=${s.default}`)
    );
    expect(nonZero).toEqual([]);
    for (const slug of ["us-az-snap", "us-ca-snap", "us-co-snap", "us-ny-snap"]) {
      const slot = getProgram(slug)!.inputs.Person.find((s) => s.name === "member_age")!;
      expect(slot.default).toBe(0);
      expect(slot.default_source).toBeUndefined();
    }
  });

  it("shows member_age without a default in describe", () => {
    const person = describeProgramPayload(getProgram("us-co-snap")!).inputs.Person.slots;
    expect(person).toContain("member_age:integer");
    expect(person.some((s) => s.startsWith("member_age:integer="))).toBe(false);
  });
});

describe.skipIf(!hasEngine)("unstated ages on the real engine", () => {
  // Elderly status comes from snap_member_is_elderly_or_disabled, not from
  // member_age, so a household that states no ages gets the benefit of the
  // same household with working-age adults stated.
  const household = (slug: string, size: number, ages: Array<number | undefined>) => {
    const program = getProgram(slug)!;
    const primary = new Set(program.inputs[program.primary_entity].map((s) => s.name));
    const earned = ["snap_gross_monthly_earned_income", "snap_countable_earned_income"].find((n) => primary.has(n))!;
    const members: MemberSpec[] = ages.map((age) => ({ facts: age === undefined ? {} : { member_age: age } as Facts }));
    return computeProgram({
      program,
      period: "2026-10",
      facts: { household_size: size, [earned]: size === 1 ? 1000 : 2000, household_shelter_costs_incurred: size === 1 ? 600 : 1200 },
      members,
      extraOutputs: ["snap_household_has_elderly_or_disabled_member"],
    });
  };

  for (const slug of ["us-ca-snap", "us-co-snap", "us-ny-snap"]) {
    it(`${slug}: unstated ages compute like stated working-age ones`, async () => {
      const single = await household(slug, 1, [undefined]);
      expect(numericOutput(single, "snap_benefit")).toBe(numericOutput(await household(slug, 1, [35]), "snap_benefit"));
      expect(numericOutput(single, "snap_benefit")).toBe(212);
      expect(output(single, "snap_household_has_elderly_or_disabled_member")).toBe("not_holds");

      const family = await household(slug, 3, [undefined, undefined, undefined]);
      expect(numericOutput(family, "snap_benefit")).toBe(numericOutput(await household(slug, 3, [35, 8, 5]), "snap_benefit"));
      expect(numericOutput(family, "snap_benefit")).toBe(519);
    });
  }
});
