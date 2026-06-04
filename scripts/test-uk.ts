import { computeUkPersonalAllowance } from "../src/lib/programs/uk-personal-allowance";
import { computeUkUniversalCredit } from "../src/lib/programs/uk-uc";

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
  const ucCases: Array<{ label: string; facts: Parameters<typeof computeUkUniversalCredit>[0]; expectAward: number }> = [
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
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
