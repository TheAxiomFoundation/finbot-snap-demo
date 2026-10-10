/** Reproduce the release bump's sampled Florida citizen-household parity.
 * REQUIRE_ENGINE=1 bun scripts/test-florida-differential.ts
 * Uses the pinned v0.1.2 local engine for both releases, and downloads only the
 * baseline Florida artifact unless FLORIDA_BASELINE_ARTIFACT points to a copy.
 * Results go to /private/tmp/hub-finbot-flbump-r2-florida by default; override
 * FLORIDA_DIFFERENTIAL_OUTPUT_DIR to keep separate runs. No Git writes occur.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProgram, type Catalog, type CatalogProgram } from "../src/lib/catalog";
import { runCompiled } from "../src/lib/engine";
import { buildRequest, shapeResult } from "../src/lib/request-builder";
import fixture from "./florida-differential.json";

type Values = Record<string, number | string | boolean>;
interface CaseResult { size: number; earned: number; shelter: number; values: Values }
interface ReleaseResult {
  accepted: number;
  grid: CaseResult[];
  sizes: CaseResult[];
  bbce: Array<CaseResult & { percent: number }>;
}
type Release = "baseline" | "current";
const root = process.cwd();
const binary = process.env.AXIOM_RULES_ENGINE_BINARY || path.join(root, "engine/axiom-rules-engine/target/release/axiom-rules-engine");
const selected = Object.keys(fixture.expected_grid_changed_counts);
const headline = Object.keys(fixture.size_three_headline);
const outputDir = process.env.FLORIDA_DIFFERENTIAL_OUTPUT_DIR || "/private/tmp/hub-finbot-flbump-r2-florida";

function checkHash(file: string, expected: string): void {
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), expected, `artifact SHA-256: ${file}`);
}

async function runRelease(release: Release): Promise<ReleaseResult> {
  const catalog: Catalog | undefined = release === "baseline"
    ? JSON.parse(execFileSync("git", ["show", `${fixture.baseline.catalog_ref}:src/lib/generated/catalog.json`], { maxBuffer: 32 * 1024 * 1024 }).toString())
    : undefined;
  const program: CatalogProgram | undefined = catalog
    ? catalog.programs.find((p) => p.slug === fixture.program)
    : getProgram(fixture.program);
  assert.ok(program, `catalog has ${fixture.program}`);
  if (catalog) assert.equal(catalog.release_tag, fixture.baseline.release_tag);
  let accepted = 0;
  async function compute(size: number, earned: number, shelter: number): Promise<CaseResult> {
    const built = buildRequest({
      program: program!, period: fixture.period,
      facts: { household_size: size, snap_gross_monthly_earned_income: earned, household_shelter_costs_incurred: shelter },
      members: Array.from({ length: size }, (_, i) => ({ facts: { member_is_us_citizen: true, member_age: i === 0 ? 35 : i === 1 ? 8 : 5 } })),
      extraOutputs: selected,
    });
    assert.equal(built.request.dataset.inputs.some((i) => i.name.endsWith("#input.assistance_group_size")), release === "baseline");
    const shaped = shapeResult(program!, built, await runCompiled(program!.slug, built.request));
    assert.ok(shaped.applied.disclosures.some((text) => text.includes("Florida") && text.includes("broad-based")), "Florida BBCE disclosure retained");
    assert.ok(shaped.applied.disclosures.some((text) => text.includes("FY2027")), "standards-year disclosure retained");
    const values = Object.fromEntries(shaped.outputs.filter((o) => selected.includes(o.name)).map((o) => [o.name, o.value])) as Values;
    for (const name of selected) assert.ok(Object.hasOwn(values, name), `returned output: ${name}`);
    accepted++;
    return { size, earned, shelter, values };
  }
  const grid: CaseResult[] = [];
  for (const size of fixture.grid.sizes) for (const earned of fixture.grid.earnings) for (const shelter of fixture.grid.shelter) {
    grid.push(await compute(size, earned, shelter));
  }
  const sizes: CaseResult[] = [];
  for (const row of fixture.size_cases.expected) sizes.push(await compute(row.size, fixture.size_cases.earned, fixture.size_cases.shelter));
  const bbce: ReleaseResult["bbce"] = [];
  for (const percent of fixture.bbce.percentages) {
    const row = await compute(fixture.bbce.size, fixture.bbce.fpl * percent / 100, fixture.bbce.shelter);
    assert.equal(row.values.snap_eligible, "not_holds", `${release} BBCE ${percent}% eligibility`);
    assert.equal(row.values.snap_benefit, 0, `${release} BBCE ${percent}% benefit`);
    bbce.push({ ...row, percent });
  }
  return { accepted, grid, sizes, bbce };
}

async function main(): Promise<void> {
  assert.equal(process.env.REQUIRE_ENGINE, "1", "set REQUIRE_ENGINE=1");
  assert.ok(!process.env.AXIOM_ENGINE_URL, "unset AXIOM_ENGINE_URL to use the pinned local engine");
  assert.equal(execFileSync(binary, ["--version"]).toString().trim(), fixture.engine.version);
  // Separate processes let both releases use the production engine adapter;
  // its artifact directory is fixed when the module loads.
  const childRelease = process.argv[2];
  if (childRelease === "baseline" || childRelease === "current") {
    process.stdout.write(JSON.stringify(await runRelease(childRelease)));
    return;
  }
  assert.equal(childRelease, undefined, "unexpected argument");
  const lock = JSON.parse(readFileSync(path.join(root, "artifacts.lock.json"), "utf8"));
  assert.equal(lock.engine.ref, fixture.engine.ref);
  assert.equal(lock.release_tag, fixture.current.release_tag);
  mkdirSync(outputDir, { recursive: true });
  const baselineArtifact = process.env.FLORIDA_BASELINE_ARTIFACT || path.join(outputDir, "baseline", `${fixture.program}.compiled.json`);
  if (!existsSync(baselineArtifact)) {
    assert.ok(!process.env.FLORIDA_BASELINE_ARTIFACT, "FLORIDA_BASELINE_ARTIFACT must exist");
    const url = `https://github.com/TheAxiomFoundation/rulespec-us/releases/download/${fixture.baseline.release_tag}/${fixture.program}.compiled.json`;
    const response = await fetch(url);
    assert.ok(response.ok, `baseline artifact download: HTTP ${response.status}`);
    mkdirSync(path.dirname(baselineArtifact), { recursive: true });
    writeFileSync(baselineArtifact, Buffer.from(await response.arrayBuffer()));
  }
  checkHash(baselineArtifact, fixture.baseline.artifact_sha256);
  const currentArtifactsDir = process.env.AXIOM_ARTIFACTS_DIR || path.join(root, "engine/artifacts");
  checkHash(path.join(currentArtifactsDir, `${fixture.program}.compiled.json`), fixture.current.artifact_sha256);
  const script = fileURLToPath(import.meta.url);
  const run = (release: Release, artifactsDir: string): ReleaseResult => JSON.parse(execFileSync(process.execPath, [script, release], {
    env: { ...process.env, AXIOM_RULES_ENGINE_BINARY: binary, AXIOM_ARTIFACTS_DIR: artifactsDir }, maxBuffer: 4 * 1024 * 1024,
  }).toString());
  const baseline = run("baseline", path.dirname(baselineArtifact));
  writeFileSync(path.join(outputDir, "baseline.json"), JSON.stringify(baseline, null, 2));
  const current = run("current", currentArtifactsDir);
  writeFileSync(path.join(outputDir, "current.json"), JSON.stringify(current, null, 2));
  assert.equal(baseline.grid.length, fixture.grid.cases);
  assert.equal(current.grid.length, fixture.grid.cases);
  const changedCounts: Record<string, number> = Object.fromEntries(selected.map((name) => [name, 0]));
  for (const [i, old] of baseline.grid.entries()) {
    const next = current.grid[i];
    assert.deepEqual([next.size, next.earned, next.shelter], [old.size, old.earned, old.shelter]);
    for (const name of selected) if (old.values[name] !== next.values[name]) changedCounts[name]++;
  }
  assert.deepEqual(changedCounts, fixture.expected_grid_changed_counts, "per-output grid change counts");
  let sizeExpectations = 0;
  for (const [i, expected] of fixture.size_cases.expected.entries()) {
    const old = baseline.sizes[i];
    const next = current.sizes[i];
    assert.equal(next.size, expected.size);
    for (const [j, name] of fixture.size_cases.outputs.entries()) {
      assert.equal(old.values[name], fixture.size_cases.baseline_values[j], `baseline size ${expected.size}: ${name}`);
      assert.equal(next.values[name], expected.values[j], `current size ${expected.size}: ${name}`);
      sizeExpectations++;
    }
    for (const name of headline) assert.equal(next.values[name], old.values[name], `size ${expected.size} headline parity: ${name}`);
  }
  for (const result of [baseline, current]) {
    const named = result.sizes.find((row) => row.size === 3)!;
    for (const [name, expected] of Object.entries(fixture.size_three_headline)) assert.equal(named.values[name], expected);
  }
  const expectedPerRelease = fixture.grid.cases + fixture.size_cases.expected.length + fixture.bbce.percentages.length;
  assert.equal(baseline.accepted, expectedPerRelease);
  assert.equal(current.accepted, expectedPerRelease);
  const summary = { baselineAccepted: baseline.accepted, currentAccepted: current.accepted, gridCases: current.grid.length, changedCounts, sizeExpectations, bbceCasesPerRelease: current.bbce.length };
  writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`${baseline.accepted + current.accepted}/${2 * expectedPerRelease} requests accepted; headline parity ${fixture.grid.cases}/${fixture.grid.cases} per output; grid output counts ${selected.length}/${selected.length}; size expectations ${sizeExpectations}/${sizeExpectations} per release; BBCE ${current.bbce.length}/${current.bbce.length} denied/$0 per release; 0 failures`);
  console.log(`Results: ${outputDir}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
