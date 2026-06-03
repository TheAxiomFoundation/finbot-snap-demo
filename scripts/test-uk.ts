import { computeUkPersonalAllowance } from "../src/lib/programs/uk-personal-allowance";

async function main() {
  const cases = [
    { label: "£50,000 (base allowance)", facts: { adjusted_net_income: 50000 }, expected: 12570 },
    { label: "£120,000 (mid taper)", facts: { adjusted_net_income: 120000 }, expected: 2570 },
    { label: "£125,140 (full taper)", facts: { adjusted_net_income: 125140 }, expected: 0 },
    { label: "£100,000 (at threshold)", facts: { adjusted_net_income: 100000 }, expected: 12570 },
    { label: "no claim", facts: { adjusted_net_income: 50000, individual_makes_claim: false }, expected: 0 },
  ];
  for (const c of cases) {
    const r = await computeUkPersonalAllowance(c.facts);
    const ok = r.personal_allowance === c.expected;
    console.log(`${ok ? "✓" : "✗"} ${c.label}: got £${r.personal_allowance} expected £${c.expected}`);
    if (!ok) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
