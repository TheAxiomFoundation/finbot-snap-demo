/**
 * Certification gate: compute every cataloged program with pure defaults.
 *
 * Asserts the engine accepts the generic request builder's output for all
 * programs in the pinned release — engine success, every certified output
 * present in the response, scalars finite. Run after a pin bump and before
 * deploying. Uses the local subprocess transport unless AXIOM_ENGINE_URL is
 * set, in which case it exercises the deployed engine.
 *
 * Run: bun run test:smoke
 */
import { getCatalog } from "../src/lib/catalog";
import { computeProgram } from "../src/lib/request-builder";

async function main() {
  const catalog = getCatalog();
  let failures = 0;

  for (const program of catalog.programs) {
    const started = Date.now();
    try {
      const result = await computeProgram({ program });
      const problems: string[] = [];
      for (const name of program.certified_outputs) {
        const output = result.outputs.find((o) => o.name === name);
        if (!output) {
          problems.push(`certified output ${name} missing from response`);
          continue;
        }
        if (output.semantics === "judgment") {
          if (output.value !== "holds" && output.value !== "not_holds") {
            problems.push(`judgment ${name} returned ${JSON.stringify(output.value)}`);
          }
        } else if (typeof output.value !== "number" || !Number.isFinite(output.value)) {
          problems.push(`scalar ${name} returned ${JSON.stringify(output.value)}`);
        }
      }
      const ms = Date.now() - started;
      if (problems.length) {
        failures++;
        console.log(`FAIL ${program.slug} (${ms}ms)`);
        for (const p of problems) console.log(`     ${p}`);
      } else {
        const primary = result.outputs.find((o) => o.name === program.primary_output);
        console.log(
          `ok   ${program.slug.padEnd(20)} ${String(primary?.value).padStart(10)} ${primary?.unit ?? ""} (${result.outputs.length} outputs, ${ms}ms)`
        );
      }
    } catch (err) {
      failures++;
      console.log(`FAIL ${program.slug}`);
      console.log(`     ${(err as Error).message.slice(0, 500)}`);
    }
  }

  console.log(
    failures === 0
      ? `\nsmoke test passed: ${catalog.programs.length}/${catalog.programs.length} programs`
      : `\nsmoke test FAILED: ${failures}/${catalog.programs.length} programs failing`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
