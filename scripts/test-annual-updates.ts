/**
 * Annual-update guard: a compute whose period is past the date an annually
 * reissued parameter was due (SNAP's October 1 cost-of-living adjustment)
 * must disclose that it still evaluates last year's values — and nothing
 * else may change.
 *
 *   1. classification — fiscal-year sources and yearly version runs count as
 *      annual; one-off versions and short statutory phase-ins don't.
 *   2. catalog — every SNAP program and Maine TANF fall due 2026-10-01 under
 *      the pinned release; no other TANF or tax program carries a due date.
 *   3. request builder — the WARNING and disclosure appear exactly from the
 *      due date, only on outputs that reach an overdue parameter.
 *   4. engine (skipped without one) — the assistant's compute tool at
 *      2026-10 returns the same FY2026 amount with the WARNING attached, and
 *      every non-SNAP oracle case computes the same value at 2026-10 as at
 *      2026-07 with no warning.
 *
 * Run: bun run test:annual-updates
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  annualUpdateDigestNote,
  annualUpdateNoticesAt,
  classifyAnnualParameter,
  groupAnnualUpdates,
  MIN_ANNUAL_STEPS,
  overdueAnnualUpdates,
} from "../src/lib/annual-updates";
import { getCatalog, getProgram, type CatalogProgram } from "../src/lib/catalog";
import { buildRequest, computeProgram, type Facts, type MemberSpec } from "../src/lib/request-builder";
import { tools } from "../src/lib/tools";
import { skipWithoutEngine } from "./snap-scenarios";

const DUE = "2026-10-01";
/** Programs whose headline reaches an annually reissued parameter under the
 *  pinned release. A pin bump that encodes FY2027 moves their due date to
 *  2027-10-01 and this list stays; a new annual program must be added here. */
const EXPECTED_ANNUAL = new Set([
  ...["al", "az", "ca", "co", "fl", "ga", "ma", "nc", "ny", "sc", "tn"].map((s) => `us-${s}-snap`),
  "us-me-tanf",
]);

let failures = 0;
let passes = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passes++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${(err as Error).message.split("\n").join("\n     ")}`);
  }
}

const annualWarnings = (notes: string[]) => notes.filter((n) => n.startsWith("WARNING: period") && n.includes("annually reissued"));

function classification() {
  check("fiscal-year source → annual, due one year after its version, FY label kept", () => {
    const got = classifyAnnualParameter({
      id: "us:policies/usda/snap/fy-2026-cola/maximum-allotments#snap_maximum_allotment_table",
      versions: [{ effective_from: "2025-10-01" }],
    });
    assert.deepEqual(got, {
      basis: "fiscal_year_source",
      last_effective_from: "2025-10-01",
      due: "2026-10-01",
      fiscal_year: 2026,
      source: "us:policies/usda/snap/fy-2026-cola/maximum-allotments",
    });
  });
  check("fiscal-year source with a newer version keeps rolling and drops a mismatched FY label", () => {
    const got = classifyAnnualParameter({
      id: "us:policies/usda/snap/fy-2026-cola/deductions#x",
      versions: [{ effective_from: "2025-10-01" }, { effective_from: "2026-10-01" }],
    });
    assert.equal(got?.due, "2027-10-01");
    assert.equal(got?.fiscal_year, undefined);
  });
  check("state fiscal year (July start) → annual, but no federal FY label", () => {
    const got = classifyAnnualParameter({ id: "us-xx:policies/agency/fy-2026-budget#x", versions: [{ effective_from: "2025-07-01" }] });
    assert.equal(got?.due, "2026-07-01");
    assert.equal(got?.fiscal_year, undefined);
  });
  check(`${MIN_ANNUAL_STEPS}+ consecutive yearly versions → annual (Maine TANF shape)`, () => {
    const got = classifyAnnualParameter({
      id: "us-me:regulations/dhhs/ofi/chapter-331/tanf-rule-125a/maximum-benefit-and-standard-of-need#x",
      versions: ["2021", "2022", "2023", "2024", "2025"].map((y) => ({ effective_from: `${y}-10-01` })),
    });
    assert.equal(got?.basis, "annual_versions");
    assert.equal(got?.due, "2026-10-01");
  });
  check("short statutory phase-in → not annual (Illinois SCRETD shape)", () => {
    const got = classifyAnnualParameter({
      id: "us-il:statutes/320/30/2#maximum_household_income",
      versions: ["0001-01-01", "2006-01-01", "2012-01-01", "2022-01-01", "2025-01-01", "2026-01-01", "2027-01-01"].map((d) => ({ effective_from: d })),
    });
    assert.equal(got, null);
  });
  check("one-off version without a fiscal-year source → not annual", () => {
    assert.equal(classifyAnnualParameter({ id: "us:statutes/26/24/h#ctc_amount", versions: [{ effective_from: "2026-01-01" }] }), null);
    assert.equal(classifyAnnualParameter({ id: null, versions: [] }), null);
  });
  check("fy marker must be a whole path token", () => {
    assert.equal(classifyAnnualParameter({ id: "us:policies/x/notify-2026#x", versions: [{ effective_from: "2025-10-01" }] }), null);
  });
  check("grouping merges parameters that fall due together", () => {
    const a = classifyAnnualParameter({ id: "us:policies/usda/snap/fy-2026-cola/deductions#a", versions: [{ effective_from: "2025-10-01" }] })!;
    const b = classifyAnnualParameter({ id: "us:policies/usda/snap/fy-2026-cola/maximum-allotments#b", versions: [{ effective_from: "2025-10-01" }] })!;
    const groups = groupAnnualUpdates([{ name: "b", ...b }, { name: "a", ...a }]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].parameters, ["a", "b"]);
    assert.equal(groups[0].sources.length, 2);
  });
}

function catalogShape() {
  const programs = getCatalog().programs;
  check("catalog: SNAP programs and Maine TANF carry the annual update; no other program does", () => {
    const flagged = programs.filter((p) => p.annual_updates?.length).map((p) => p.slug).sort();
    assert.deepEqual(flagged, [...EXPECTED_ANNUAL].sort());
    for (const p of programs.filter((p) => p.program_id === "snap")) {
      assert.ok(EXPECTED_ANNUAL.has(p.slug), `${p.slug} should be flagged`);
    }
  });
  check("catalog: every flagged headline is due 2026-10-01 under the pinned release", () => {
    for (const slug of EXPECTED_ANNUAL) {
      const program = getProgram(slug)!;
      const primary = program.outputs.find((o) => o.name === program.primary_output)!;
      assert.equal(primary.annual_update_due, DUE, slug);
      assert.ok(program.annual_updates!.every((u) => u.due === DUE && u.last_effective_from === "2025-10-01"), slug);
    }
  });
  check("catalog: SNAP's update names FY2026 and the FNS COLA sources", () => {
    const update = getProgram("us-ny-snap")!.annual_updates![0];
    assert.equal(update.fiscal_year, 2026);
    assert.ok(update.sources.includes("us:policies/usda/snap/fy-2026-cola/maximum-allotments"));
    assert.ok(update.parameters.includes("snap_maximum_allotment_table"));
  });
}

function requestBuilder() {
  for (const program of getCatalog().programs) {
    const grain = /^\d{4}$/.test(program.period) ? "annual" : "monthly";
    const [before, after] = grain === "annual" ? ["2026", "2027"] : ["2026-09", "2026-10"];
    check(`${program.slug}: ${before} carries no annual-update warning; ${after} ${EXPECTED_ANNUAL.has(program.slug) ? "does" : "does not"}`, () => {
      const facts: Facts = program.program_id === "snap" ? { household_size: 1 } : {};
      const early = buildRequest({ program, period: before, facts });
      assert.deepEqual(annualWarnings(early.applied.notes), [], `${before} notes`);
      assert.ok(!early.applied.disclosures.some((d) => d.includes("is not encoded yet")), `${before} disclosures`);

      const late = buildRequest({ program, period: after, facts });
      const warnings = annualWarnings(late.applied.notes);
      const disclosures = late.applied.disclosures.filter((d) => d.includes("is not encoded yet"));
      if (EXPECTED_ANNUAL.has(program.slug)) {
        assert.equal(warnings.length, 1, "one WARNING");
        assert.ok(warnings[0].startsWith(`WARNING: period ${after} is on or after ${DUE}`), warnings[0]);
        assert.ok(warnings[0].includes("Never substitute newer values from memory"));
        assert.deepEqual(disclosures, [
          program.program_id === "snap"
            ? `${program.display_name} figures use FY2026 standards; the FY2027 update due October 1, 2026 is not encoded yet, so amounts from that date may differ from current law.`
            : `${program.display_name} figures use the standards in effect from October 1, 2025; the annual update due October 1, 2026 is not encoded yet, so amounts from that date may differ from current law.`,
        ]);
        // The disclosure is user-facing copy; the model-facing WARNING stays in notes.
        assert.ok(!late.applied.notes.includes(disclosures[0]));
      } else {
        assert.deepEqual(warnings, []);
        assert.deepEqual(disclosures, []);
      }
    });
  }

  check("lookup of an output that reaches no annual parameter stays quiet past the due date", () => {
    const program = getProgram("us-co-snap")!;
    const quiet = program.outputs.find((o) => !o.annual_update_due && o.semantics === "scalar")!;
    const built = buildRequest({ program, period: "2026-12", outputsOverride: [quiet.name] });
    assert.deepEqual(annualWarnings(built.applied.notes), [], quiet.name);
    const loud = buildRequest({ program, period: "2026-12", outputsOverride: ["snap_benefit"] });
    assert.equal(annualWarnings(loud.applied.notes).length, 1);
  });

  check("overdueAnnualUpdates compares each output's own period start", () => {
    const program = getProgram("us-tn-snap")! as CatalogProgram;
    const primary = program.outputs.find((o) => o.name === program.primary_output)!;
    assert.equal(overdueAnnualUpdates(program, [{ output: primary, periodStart: "2026-09-01" }]).length, 0);
    assert.equal(overdueAnnualUpdates(program, [{ output: primary, periodStart: "2026-10-01" }]).length, 1);
    assert.equal(overdueAnnualUpdates(program, [{ output: { annual_update_due: undefined }, periodStart: "2030-01-01" }]).length, 0);
  });

  check("program pages, describe_program and the prompt digest switch on the same date", () => {
    const program = getProgram("us-ga-snap")!;
    assert.deepEqual(annualUpdateNoticesAt(program, "2026-09-01"), []);
    assert.equal(annualUpdateNoticesAt(program, DUE).length, 1);
    assert.equal(annualUpdateDigestNote(program, "2026-09-01"), "");
    assert.equal(annualUpdateDigestNote(program, DUE), "; FY2026 standards — FY2027 update due 2026-10-01 not encoded");
    assert.equal(annualUpdateDigestNote(getProgram("us-fiit")!, "2027-01-01"), "");
  });
}

interface OracleDoc {
  period: string;
  cases: Array<{
    id: string;
    program: string;
    axiom: { facts: Facts; members?: Array<{ facts: Record<string, unknown>; relations?: string[] }> };
    compare: Array<{ axiom_output: string }>;
  }>;
  shared_member_facts: Record<string, Facts>;
}

async function engineChecks() {
  if (skipWithoutEngine("test:annual-updates engine checks")) return;

  // The assistant's own tool path — exactly what the model reads.
  const ctx = { toolCallId: "annual-updates", messages: [] } as never;
  const compute = (period: string) =>
    (tools.compute as unknown as { execute: (a: unknown, c: never) => Promise<Record<string, any>> }).execute(
      { program: "us-co-snap", period, facts: { household_size: 1 } },
      ctx
    );
  const [september, october] = await Promise.all([compute("2026-09"), compute("2026-10")]);
  check("tools.compute: Colorado SNAP, 1 person, no income — FY2026 amount, WARNING only from 2026-10", () => {
    const benefit = (r: Record<string, any>) => r.outputs.find((o: { name: string }) => o.name === "snap_benefit")?.value;
    assert.equal(benefit(september), 298);
    assert.equal(benefit(october), 298, "the engine still evaluates FY2026 values in October");
    assert.deepEqual(annualWarnings(september.applied.notes), []);
    assert.equal(annualWarnings(october.applied.notes).length, 1);
    assert.ok(october.applied.disclosures.some((d: string) => d.startsWith("Colorado SNAP figures use FY2026 standards")));
  });

  // TANF and tax outputs whose values hold across 2026 are untouched: same
  // value in October as in the oracle's July period, and no warning.
  const doc = JSON.parse(readFileSync(path.join(import.meta.dirname ?? __dirname, "oracle-cases.json"), "utf8")) as OracleDoc;
  const members = (c: OracleDoc["cases"][number]): MemberSpec[] | undefined =>
    c.axiom.members?.map((m) => {
      const { $ref, ...facts } = m.facts as { $ref?: string } & Facts;
      return { facts: { ...($ref ? doc.shared_member_facts[$ref] : {}), ...facts }, relations: m.relations };
    });
  for (const c of doc.cases) {
    const program = getProgram(c.program)!;
    const snap = program.program_id === "snap";
    const run = (period: string) =>
      computeProgram({ program, period, facts: c.axiom.facts, members: members(c), extraOutputs: c.compare.map((x) => x.axiom_output) });
    const [july, october] = await Promise.all([run(doc.period), run("2026-10")]);
    check(`oracle ${c.id}: 2026-10 equals ${doc.period}${snap ? ", with the WARNING" : ", no warning"}`, () => {
      for (const { axiom_output } of c.compare) {
        const a = july.outputs.find((o) => o.name === axiom_output)?.value;
        const b = october.outputs.find((o) => o.name === axiom_output)?.value;
        assert.equal(b, a, axiom_output);
      }
      assert.equal(annualWarnings(october.applied.notes).length, snap ? 1 : 0);
      assert.deepEqual(annualWarnings(july.applied.notes), []);
    });
  }
}

async function main() {
  classification();
  catalogShape();
  requestBuilder();
  await engineChecks();
  console.log(failures === 0 ? `\nannual-update tests passed: ${passes}` : `\nannual-update tests FAILED: ${failures} of ${passes + failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
