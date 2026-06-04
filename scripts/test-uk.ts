import { computeUkPersonalAllowance } from "../src/lib/programs/uk-personal-allowance";
import { computeUkUniversalCredit } from "../src/lib/programs/uk-uc";
import { toolsForCountry } from "../src/lib/tools";

async function main() {
  console.log("--- personal allowance ---");
  const paCases = [
    { label: "£50,000 (base allowance)", facts: { adjusted_net_income: 50000 }, expected: 12570 },
    { label: "£120,000 (mid taper)", facts: { adjusted_net_income: 120000 }, expected: 2570 },
    { label: "£125,140 (full taper)", facts: { adjusted_net_income: 125140 }, expected: 0 },
    { label: "no claim", facts: { adjusted_net_income: 50000, individual_makes_claim: false }, expected: 0 },
  ];
  for (const c of paCases) {
    const r = await computeUkPersonalAllowance(c.facts);
    const ok = r.personal_allowance === c.expected;
    console.log(`${ok ? "✓" : "✗"} ${c.label}: got £${r.personal_allowance} expected £${c.expected}`);
    if (!ok) process.exitCode = 1;
  }

  console.log("\n--- universal credit (composed s.8 + regs 22/24/26/27/29/34/36) ---");
  const ucCases: Array<{
    label: string;
    facts: Parameters<typeof computeUkUniversalCredit>[0];
    expectAward: number;
    expect?: Partial<Awaited<ReturnType<typeof computeUkUniversalCredit>>["outputs"]>;
  }> = [
    // Smoke: single 25+ no kids no income → £424.90 standard allowance
    { label: "single 30, no income, no kids", facts: { eldest_adult_age: 30 }, expectAward: 424.90 },
    // Single under 25 → £338.58
    { label: "single 23, no income, no kids", facts: { eldest_adult_age: 23 }, expectAward: 338.58 },
    // Joint 30+ → £666.97
    { label: "joint 30, no income, no kids", facts: { is_joint_claim: true, eldest_adult_age: 30 }, expectAward: 666.97 },
    // Joint 30 + 2 kids → £666.97 + £351.88 + £303.94 = £1,322.79
    { label: "joint 30, 2 kids, no income", facts: { is_joint_claim: true, eldest_adult_age: 30, number_of_children: 2 }, expectAward: 1322.79 },
    // Earned-income taper test: single 30, £1000/month earned, no child / no LCW → no work allowance → 55% taper on full earnings
    //   max = 424.90, deduction = 0.55 * 1000 = 550, award = max(0, 424.90 - 550) = 0
    { label: "single 30, £1000 earned, no kids/LCW (no work allowance)", facts: { eldest_adult_age: 30, monthly_earned_income: 1000 }, expectAward: 0 },
    // Single 30 with 1 child, £1000/month earned → entitled to higher work allowance (£710 since no housing element)
    //   max = 424.90 + 351.88 = 776.78
    //   work allowance = 710, taper on (1000-710)*0.55 = 159.50
    //   award = 776.78 - 159.50 = 617.28
    { label: "single 30, 1 child, £1000 earned (higher work allowance)", facts: { eldest_adult_age: 30, number_of_children: 1, monthly_earned_income: 1000 }, expectAward: 617.28 },
    // Unearned income £100, no earned → 424.90 - 100 = 324.90
    { label: "single 30, £100 unearned, no kids/LCW", facts: { eldest_adult_age: 30, monthly_unearned_income: 100 }, expectAward: 324.90 },
    // Shared-ownership housing edge: Schedule 4 caps rent at £650 and Schedule 5 adds £120/month service charges.
    {
      label: "shared ownership, rent capped plus monthly service charge",
      facts: { eldest_adult_age: 30, monthly_rent: 800, monthly_rent_cap: 650, monthly_owner_occupier_service_charge: 120 },
      expectAward: 1194.90,
      expect: {
        renters_housing_costs_element_calculated_under_this_part: 650,
        owner_occupier_housing_costs_element_amount: 120,
        housing_cost_element_under_shared_ownership: 770,
      },
    },
    // Schedule 4 non-dependent contribution: £96.55 deducted from the capped rent amount.
    {
      label: "shared ownership, non-dependent housing contribution deducted",
      facts: {
        eldest_adult_age: 30,
        monthly_rent: 800,
        monthly_rent_cap: 650,
        monthly_owner_occupier_service_charge: 120,
        non_dependant_housing_cost_contribution_count: 1,
      },
      expectAward: 1098.35,
      expect: {
        renters_housing_costs_element_calculated_under_this_part: 553.45,
        owner_occupier_housing_costs_element_amount: 120,
        housing_cost_element_under_shared_ownership: 673.45,
      },
    },
    // Schedule 5 weekly service charge conversion: £12/week * 52 / 12 = £52/month.
    {
      label: "shared ownership, weekly service charge converted monthly",
      facts: { eldest_adult_age: 30, monthly_rent: 500, monthly_rent_cap: 500, weekly_owner_occupier_service_charge: 12 },
      expectAward: 976.90,
      expect: {
        renters_housing_costs_element_calculated_under_this_part: 500,
        owner_occupier_housing_costs_element_amount: 52,
        housing_cost_element_under_shared_ownership: 552,
      },
    },
    // Housing element present means reg 22 applies the lower work allowance (£427), not the higher one.
    {
      label: "single 30, 1 child, housing element uses lower work allowance",
      facts: { eldest_adult_age: 30, number_of_children: 1, monthly_earned_income: 1000, monthly_rent: 500, monthly_rent_cap: 500 },
      expectAward: 961.63,
      expect: {
        applicable_work_allowance_amount: 427,
        earned_income_amount_subject_to_taper: 573,
        earned_income_deduction_from_maximum_amount: 315.15,
        housing_cost_element_under_shared_ownership: 500,
      },
    },
  ];
  for (const c of ucCases) {
    const r = await computeUkUniversalCredit(c.facts);
    const got = Math.round(r.universal_credit_award_amount * 100) / 100;
    const expected = Math.round(c.expectAward * 100) / 100;
    const ok = Math.abs(got - expected) < 0.02;
    console.log(`${ok ? "✓" : "✗"} ${c.label}: award=£${got.toFixed(2)} (expected £${expected.toFixed(2)})`);
    if (!ok) {
      console.log(`    max=£${r.outputs.universal_credit_maximum_amount} deduct=£${r.outputs.universal_credit_amounts_to_be_deducted} work_allow=£${r.outputs.applicable_work_allowance_amount} earned_deduct=£${r.outputs.earned_income_deduction_from_maximum_amount}`);
      process.exitCode = 1;
    }
    for (const [key, value] of Object.entries(c.expect ?? {})) {
      const actual = r.outputs[key as keyof typeof r.outputs];
      const actualRounded = Math.round(actual * 100) / 100;
      const expectedRounded = Math.round((value ?? 0) * 100) / 100;
      const edgeOk = Math.abs(actualRounded - expectedRounded) < 0.02;
      console.log(`    ${edgeOk ? "✓" : "✗"} ${key}=£${actualRounded.toFixed(2)} (expected £${expectedRounded.toFixed(2)})`);
      if (!edgeOk) process.exitCode = 1;
    }
  }

  console.log("\n--- universal credit tool schema ---");
  const ucTool = (toolsForCountry("uk") as any).compute_uk_universal_credit;
  const parsedHousingFacts = ucTool.parameters.parse({
    is_joint_claim: true,
    eldest_adult_age: 32,
    number_of_children: 3,
    number_of_disabled_children_higher_rate: 1,
    joint_monthly_earned_income: 2500,
    monthly_rent: 500,
  });
  const toolResult = await ucTool.execute?.(parsedHousingFacts, { toolCallId: "test", messages: [] });
  const toolAward = Math.round((toolResult?.universal_credit_award_amount ?? 0) * 100) / 100;
  const expectedToolAward = 1501.29;
  const toolOk = Math.abs(toolAward - expectedToolAward) < 0.02;
  console.log(
    `${toolOk ? "✓" : "✗"} tool accepts monthly_rent and applies housing: award=£${toolAward.toFixed(2)} (expected £${expectedToolAward.toFixed(2)})`
  );
  if (!toolOk) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
