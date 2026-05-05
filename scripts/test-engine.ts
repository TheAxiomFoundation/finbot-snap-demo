/**
 * Smoke test — exercises the engine adapter end-to-end without touching OpenAI.
 *   1. happy path that mirrors the verified test fixture (expect $298)
 *   2. resource-ineligibility variant
 *   3. next-question ranking
 *   4. catalog list
 *
 * Run: `bun run engine:test` (after `bun run engine:setup`). Exits non-zero on
 * assertion failure.
 */
import { CATALOG } from "../src/lib/catalog";
import { compute } from "../src/lib/programs/co-snap";
import { rankNextQuestions } from "../src/lib/ranking";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok  ", msg);
}

async function main(): Promise<void> {
  console.log("→ catalog");
  assert(CATALOG.length >= 1, `catalog has ${CATALOG.length} program(s)`);
  assert(CATALOG[0].slug === "co-snap", "first program is co-snap");

  console.log("→ happy path: single elderly applicant, $1000 wages, $500 shelter, separate heating");
  const happy = await compute({
    period: "2026-01",
    household_size: 1,
    monthly_earnings_per_adult: 1000,
    monthly_shelter_costs: 500,
    pays_separate_heating_or_cooling: true,
    oldest_member_age: 60,
    any_member_elderly_or_disabled: false,
    primary_member_is_us_citizen: true,
    liquid_resources: 0,
  });
  console.log(
    "    allotment =",
    happy.outputs.snap_regular_month_allotment,
    "eligible =",
    happy.outputs.snap_eligible
  );
  assert(
    happy.outputs.snap_regular_month_allotment === 298,
    "allotment matches verified test fixture: $298"
  );
  assert(happy.outputs.snap_eligible === "holds", "snap_eligible holds");

  console.log("→ resource ineligibility: $5000 in checking should kill eligibility");
  const broke = await compute({
    household_size: 1,
    monthly_earnings_per_adult: 1000,
    monthly_shelter_costs: 500,
    pays_separate_heating_or_cooling: true,
    oldest_member_age: 60,
    liquid_resources: 5000,
  });
  console.log(
    "    eligible =",
    broke.outputs.snap_eligible,
    "allotment =",
    broke.outputs.snap_regular_month_allotment
  );
  assert(broke.outputs.snap_eligible === "not_holds", "high resources → not_holds");

    console.log("→ working-age applicant, age 32 (the case that previously hit missing-input errors)");
  const working = await compute({
    period: "2026-01",
    household_size: 2,
    monthly_earnings_per_adult: 1500,
    monthly_shelter_costs: 1000,
    pays_separate_heating_or_cooling: true,
    oldest_member_age: 32,
    any_member_elderly_or_disabled: false,
    primary_member_is_us_citizen: true,
    liquid_resources: 200,
  });
  console.log(
    "    eligible =",
    working.outputs.snap_eligible,
    "allotment =",
    working.outputs.snap_regular_month_allotment
  );
  assert(typeof working.outputs.snap_regular_month_allotment === "number", "working-age: returned a number");

  console.log("→ rank_next_question with shelter and utilities unknown");
  const ranked = await rankNextQuestions({
    household_size: 1,
    monthly_earnings_per_adult: 1000,
    oldest_member_age: 60,
    liquid_resources: 0,
    primary_member_is_us_citizen: true,
  });
  console.log("    top:", ranked[0]?.question, "·", `$${ranked[0]?.variance_dollars}`);
  assert(ranked.length > 0, "got ranked candidates");
  assert(ranked[0].variance_dollars > 0, "top candidate moves the allotment");

  console.log("\nall good.");
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
