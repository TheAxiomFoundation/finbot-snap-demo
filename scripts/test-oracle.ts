/**
 * Oracle regression: our engine vs frozen PolicyEngine values on identical
 * households (scripts/oracle-cases.json).
 *
 * Population-scale Axiom↔PolicyEngine agreement for these programs is
 * established separately in axiom-oracles (Enhanced CPS comparisons); these
 * cases pin the app's request-builder layer — slot mapping, defaults, member
 * wiring, period handling — to the same numbers on concrete households.
 *
 * Refresh the PE side with `python3 scripts/oracle-pe.py --update` when
 * bumping policyengine-us.
 *
 * Run: bun run test:oracle   (requires local engine or AXIOM_ENGINE_URL)
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { getProgram } from "../src/lib/catalog";
import { computeProgram, type Facts, type MemberSpec } from "../src/lib/request-builder";

interface OracleCase {
  id: string;
  description: string;
  program: string;
  tolerance: number;
  axiom: { facts: Facts; members?: Array<{ facts: Record<string, unknown>; relations?: string[] }> };
  pe_values: Record<string, number>;
  compare: Array<{ axiom_output: string; pe_variable: string }>;
}

interface OracleDoc {
  pe_version: string;
  period: string;
  cases: OracleCase[];
  shared_member_facts: Record<string, Facts>;
}

function expandMembers(
  members: OracleCase["axiom"]["members"],
  shared: Record<string, Facts>
): MemberSpec[] | undefined {
  if (!members) return undefined;
  return members.map((member) => {
    const { $ref, ...facts } = member.facts as { $ref?: string } & Facts;
    return {
      facts: { ...($ref ? shared[$ref] : {}), ...facts },
      relations: member.relations,
    };
  });
}

async function main() {
  const doc = JSON.parse(
    readFileSync(path.join(import.meta.dirname ?? __dirname, "oracle-cases.json"), "utf8")
  ) as OracleDoc;

  console.log(`oracle: policyengine_us ${doc.pe_version} (frozen) · period ${doc.period}\n`);
  let failures = 0;

  for (const c of doc.cases) {
    const program = getProgram(c.program);
    if (!program) {
      failures++;
      console.log(`FAIL ${c.id}: program ${c.program} not in catalog`);
      continue;
    }
    try {
      const result = await computeProgram({
        program,
        period: doc.period,
        facts: c.axiom.facts,
        members: expandMembers(c.axiom.members, doc.shared_member_facts),
        extraOutputs: c.compare.map((x) => x.axiom_output),
      });
      const problems: string[] = [];
      const values: string[] = [];
      for (const { axiom_output, pe_variable } of c.compare) {
        const ours = result.outputs.find((o) => o.name === axiom_output)?.value;
        const pe = c.pe_values[pe_variable];
        values.push(`${axiom_output}=${ours} vs pe ${pe_variable}=${pe}`);
        if (typeof ours !== "number" || !Number.isFinite(ours)) {
          problems.push(`${axiom_output} is not numeric: ${JSON.stringify(ours)}`);
        } else if (Math.abs(ours - pe) > c.tolerance) {
          problems.push(`${axiom_output}=${ours} differs from PolicyEngine ${pe} by ${Math.abs(ours - pe).toFixed(2)} (tolerance ${c.tolerance})`);
        }
      }
      if (problems.length) {
        failures++;
        console.log(`FAIL ${c.id}`);
        for (const p of problems) console.log(`     ${p}`);
      } else {
        console.log(`ok   ${c.id.padEnd(22)} ${values.join(" · ")}`);
      }
    } catch (err) {
      failures++;
      console.log(`FAIL ${c.id}: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  console.log(
    failures === 0
      ? `\noracle tests passed: ${doc.cases.length}/${doc.cases.length} cases agree with PolicyEngine`
      : `\noracle tests FAILED: ${failures}/${doc.cases.length}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
