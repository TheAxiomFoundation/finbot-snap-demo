/** Historical requests still need facts referenced only by older formulas. */
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";

import { getCatalog, getProgram } from "../src/lib/catalog";
import { computeProgram } from "../src/lib/request-builder";
import { tools } from "../src/lib/tools";

export async function runHistoricalRegressions() {
  // The engine CI job fetches artifacts before running this suite. Keep this
  // exhaustive comparison here so ordinary unit tests need no artifact fetch.
  const programs = getCatalog().programs;
  const artifactPath = (slug: string) => path.resolve(process.env.AXIOM_ARTIFACTS_DIR ?? "engine/artifacts", `${slug}.compiled.json`);
  const localArtifactsAvailable = programs.every((program) => {
    try { accessSync(artifactPath(program.slug), constants.R_OK); return true; }
    catch { return false; }
  });
  const auditPrograms = process.env.AXIOM_ENGINE_URL && !localArtifactsAvailable ? [] : programs;
  if (auditPrograms.length === 0) {
    console.log("SKIP local historical-input catalog audit: hosted engine selected and full local artifacts unavailable; historical engine queries remain required.");
  }
  let checked = 0;
  for (const catalogProgram of auditPrograms) {
    const artifact = JSON.parse(readFileSync(artifactPath(catalogProgram.slug), "utf8"));
    const names = new Set(Object.values(catalogProgram.inputs).flat().map((slot) => slot.name));
    const visit = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node === null || typeof node !== "object") return;
      const expression = node as Record<string, unknown>;
      if (expression.kind === "input" && typeof expression.name === "string") {
        assert.ok(names.has(expression.name), `${catalogProgram.slug}: historical input ${expression.name} missing from catalog`);
        checked++;
      }
      Object.values(expression).forEach(visit);
    };
    for (const rule of artifact.program.derived) {
      for (const version of rule.versions ?? []) visit(version.expr);
    }
  }
  if (auditPrograms.length > 0) {
    console.log(`ok   catalog covers ${checked} historical formula input references across ${auditPrograms.length} programs`);
  }

  const program = getProgram("us-ny-snap");
  assert.ok(program, "us-ny-snap not in catalog");
  const result = await computeProgram({
    program,
    period: "2025-06",
    members: [{ facts: { member_age: 35, member_is_us_citizen: false, member_is_refugee: true } }],
    outputsOverride: ["snap_member_citizenship_or_alien_status_eligible"],
  });
  const citizenship = result.outputs.find((output) => output.name === "snap_member_citizenship_or_alien_status_eligible");
  assert.ok(citizenship, "historical citizenship judgment missing from result");
  assert.equal(citizenship.value, "holds", "June 2025 refugee citizenship eligibility");
  console.log("ok   us-ny-snap historical June 2025 refugee: citizenship judgment holds");

  const unavailable = await tools.lookup_value.execute!({
    program: program.slug,
    output: "snap_member_citizenship_or_alien_status_eligible",
    period: "2025-07",
    members: [{ facts: { member_age: 35, member_is_us_citizen: true } }],
  }, { toolCallId: "historical-formula-gap", messages: [] });
  assert.ok("kind" in unavailable);
  assert.equal(unavailable.kind, "no_formula_version");
  assert.ok("error" in unavailable);
  assert.equal(unavailable.error, "Axiom has no rule in force for 2025-07 for snap_member_citizenship_or_alien_status_eligible.");
  assert.ok(!("value" in unavailable), "a missing formula must not produce a benefit value");
  assert.ok(!("outputs" in unavailable), "a missing formula must not produce calculated outputs");
  console.log("ok   us-ny-snap historical July 2025 citizen: missing-rule limitation disclosed, no value");
}
