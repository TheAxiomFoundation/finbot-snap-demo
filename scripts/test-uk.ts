import { computeUkPersonalAllowance } from "../src/lib/programs/uk-personal-allowance";
import { computeUkUniversalCreditElements } from "../src/lib/programs/uk-uc";

async function main() {
  console.log("--- personal allowance ---");
  const paCases = [
    { label: "£50,000 (base allowance)", facts: { adjusted_net_income: 50000 }, expected: 12570 },
    { label: "£120,000 (mid taper)", facts: { adjusted_net_income: 120000 }, expected: 2570 },
    { label: "£125,140 (full taper)", facts: { adjusted_net_income: 125140 }, expected: 0 },
    { label: "£100,000 (at threshold)", facts: { adjusted_net_income: 100000 }, expected: 12570 },
    { label: "no claim", facts: { adjusted_net_income: 50000, individual_makes_claim: false }, expected: 0 },
  ];
  for (const c of paCases) {
    const r = await computeUkPersonalAllowance(c.facts);
    const ok = r.personal_allowance === c.expected;
    console.log(`${ok ? "✓" : "✗"} ${c.label}: got £${r.personal_allowance} expected £${c.expected}`);
    if (!ok) process.exitCode = 1;
  }

  console.log("\n--- universal credit elements ---");
  // Reg 36 amounts as encoded in rulespec-uk's reg 36 YAML at HEAD:
  //   single under 25: £338.58 | single 25+: £424.90
  //   joint both under 25: £528.34 | joint either 25+: £666.97
  //   first child: £351.88 | subsequent child: £303.94
  //   disabled child lower: £164.79 | higher: £514.71
  //   LCWRA ordinary: £217.26 | LCWRA protected (pre-commencement): £429.80
  //   carer element: £209.34
  //   childcare max 1 child: £1,071.09 | 2+: £1,836.16
  const ucCases: Array<{ label: string; facts: Parameters<typeof computeUkUniversalCreditElements>[0]; expectMax: number; expect?: Record<string, number> }> = [
    { label: "single 23, no kids", facts: { is_joint_claim: false, eldest_adult_age: 23 }, expectMax: 338.58, expect: { standard_allowance_amount: 338.58 } },
    { label: "single 30, no kids", facts: { is_joint_claim: false, eldest_adult_age: 30 }, expectMax: 424.90, expect: { standard_allowance_amount: 424.90 } },
    { label: "joint 30, no kids", facts: { is_joint_claim: true, eldest_adult_age: 30 }, expectMax: 666.97, expect: { standard_allowance_amount: 666.97 } },
    { label: "joint 30, 2 kids", facts: { is_joint_claim: true, eldest_adult_age: 30, number_of_children: 2 }, expectMax: 666.97 + 351.88 + 303.94, expect: { total_child_element_amount: 351.88 + 303.94 } },
    { label: "joint 30, 2 kids, 1 in childcare", facts: { is_joint_claim: true, eldest_adult_age: 30, number_of_children: 2, number_of_children_in_childcare: 1 }, expectMax: 666.97 + 351.88 + 303.94 + 1071.09 },
    { label: "single 30 with LCWRA", facts: { is_joint_claim: false, eldest_adult_age: 30, has_lcwra: true }, expectMax: 424.90 + 217.26, expect: { lcwra_element_amount: 217.26 } },
    { label: "single 30 with LCWRA (protected)", facts: { is_joint_claim: false, eldest_adult_age: 30, has_lcwra: true, is_pre_commencement_lcwra: true }, expectMax: 424.90 + 429.80, expect: { lcwra_element_amount: 429.80 } },
    { label: "single 30 with carer", facts: { is_joint_claim: false, eldest_adult_age: 30, has_carer: true }, expectMax: 424.90 + 209.34, expect: { carer_element: 209.34 } },
    { label: "joint 30, 1 disabled child (lower)", facts: { is_joint_claim: true, eldest_adult_age: 30, number_of_children: 1, number_of_disabled_children_lower_rate: 1 }, expectMax: 666.97 + 351.88 + 164.79 },
    { label: "joint 30, 1 disabled child (higher)", facts: { is_joint_claim: true, eldest_adult_age: 30, number_of_children: 1, number_of_disabled_children_higher_rate: 1 }, expectMax: 666.97 + 351.88 + 514.71 },
  ];
  for (const c of ucCases) {
    const r = await computeUkUniversalCreditElements(c.facts);
    const okMax = Math.abs(r.max_uc_monthly_amount - c.expectMax) < 0.01;
    let okSub = true;
    if (c.expect) {
      for (const [k, v] of Object.entries(c.expect)) {
        const got = (r.outputs as Record<string, number>)[k];
        if (Math.abs(got - v) > 0.01) { okSub = false; console.log(`    ✗ ${k}: got £${got} expected £${v}`); }
      }
    }
    const ok = okMax && okSub;
    console.log(`${ok ? "✓" : "✗"} ${c.label}: max=£${r.max_uc_monthly_amount.toFixed(2)} (expected £${c.expectMax.toFixed(2)})`);
    if (!ok) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
