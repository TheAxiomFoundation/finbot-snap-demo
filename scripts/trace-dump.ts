/**
 * Phase-0 investigation: run one realistic compute (the ny-snap-family3
 * oracle case) through the production request path and report what the
 * engine's `trace` actually contains — size, node count, the primary
 * output's dependency closure, and citation coverage.
 *
 * Usage: bun x tsx scripts/trace-dump.ts [program-slug]
 * Writes the full raw response next to a printed summary:
 *   eval/runs/trace-dump-<slug>.json (gitignored)
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { getProgram } from "../src/lib/catalog";
import { buildRequest } from "../src/lib/request-builder";
import { runCompiled } from "../src/lib/engine";

const slug = process.argv[2] ?? "us-ny-snap";

const ORACLE_FACTS: Record<string, boolean | number | string> = {
  household_size: 3,
  snap_gross_monthly_earned_income: 2078,
  household_shelter_costs_incurred: 1300,
  household_incurred_or_anticipated_heating_or_cooling_costs_separate_from_rent_or_mortgage: true,
  household_incurs_heating_or_cooling_expenses_separately_from_rent_or_mortgage: true,
};

type TraceNode = {
  kind: "scalar" | "judgment";
  name: string;
  id?: string;
  value?: unknown;
  outcome?: string;
  source?: string;
  source_url?: string;
  rounding?: string;
  pre_rounding_value?: unknown;
  dependencies: string[];
};

async function main() {
  const program = getProgram(slug);
  if (!program) throw new Error(`unknown program: ${slug}`);

  const built = buildRequest({ program, period: "2026-07", facts: ORACLE_FACTS });
  const t0 = Date.now();
  const response = await runCompiled(program.slug, built.request);
  const engineMs = Date.now() - t0;

  const raw = JSON.stringify(response);
  const result = response.results[0];
  const trace = (result?.trace ?? {}) as Record<string, TraceNode>;
  const nodes = Object.entries(trace);

  // Closure of the primary output, walking `dependencies`.
  const primaryKey =
    nodes.find(([, n]) => n.name === program.primary_output)?.[0] ?? null;
  const closure = new Set<string>();
  const queue = primaryKey ? [primaryKey] : [];
  while (queue.length) {
    const key = queue.pop()!;
    if (closure.has(key)) continue;
    closure.add(key);
    for (const dep of trace[key]?.dependencies ?? []) queue.push(dep);
  }

  const leaves = nodes.filter(([, n]) => n.dependencies.length === 0);
  const withId = nodes.filter(([, n]) => n.id).length;
  const withSource = nodes.filter(([, n]) => n.source || n.source_url).length;
  const rounded = nodes.filter(([, n]) => n.pre_rounding_value !== undefined);

  console.log(`program            ${slug} (period 2026-07, ${engineMs}ms engine wall)`);
  console.log(`requested/actual   ${response.metadata.requested_mode}/${response.metadata.actual_mode}`);
  console.log(`response size      ${(raw.length / 1024).toFixed(1)} KB total`);
  console.log(`trace size         ${(JSON.stringify(trace).length / 1024).toFixed(1)} KB`);
  console.log(`trace nodes        ${nodes.length} evaluated (of ${program.outputs.length} encoded outputs)`);
  console.log(`  with legal id    ${withId}`);
  console.log(`  with source/url  ${withSource}`);
  console.log(`  leaf nodes       ${leaves.length} (parameters/no deps)`);
  console.log(`  rounding shown   ${rounded.length}`);
  console.log(`primary output     ${program.primary_output} → closure of ${closure.size} nodes`);

  if (primaryKey) {
    console.log(`\n-- first hops from ${program.primary_output} --`);
    for (const dep of trace[primaryKey].dependencies) {
      const n = trace[dep];
      const val = n?.kind === "judgment" ? n.outcome : JSON.stringify(n?.value);
      console.log(`  ${n?.name ?? dep}  =  ${val}  ${n?.id ? `[${n.id}]` : ""}`);
    }
  }

  const outDir = path.join(process.cwd(), "eval", "runs");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `trace-dump-${slug}.json`);
  await fs.writeFile(outPath, JSON.stringify(response, null, 1));
  console.log(`\nfull response written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
