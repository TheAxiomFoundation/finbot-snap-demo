/**
 * Nothing a visitor or the model reads may call these rules "certified".
 * Axiom's certification ledger is a separate, gated artifact (api.axiom.org
 * /v1/ready); the pinned release manifest only lists each program's
 * outputs. The catalog's legacy `certified` / `certified_outputs` field
 * names are internal and never reach users or the model under that name.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getCatalog } from "./catalog";
import { INPUT_PLACEHOLDER, PAGE_METADATA, RAW_SYSTEM } from "./copy";
import { describeProgramPayload } from "./describe";
import { prefetchSection } from "./prefetch";
import { buildSystemPrompt } from "./prompts";
import { buildRequest, shapeResult } from "./request-builder";
import { tools } from "./tools";

// The standalone word, not snake_case legal slot names that happen to
// contain it (`..._physician_disability_certification_...`).
const CERTIFIED = /(?<![a-z_])certif/i;

describe("no certified claims", () => {
  it("static copy", () => {
    for (const text of [INPUT_PLACEHOLDER, RAW_SYSTEM, PAGE_METADATA.title, PAGE_METADATA.description]) {
      expect(text).not.toMatch(CERTIFIED);
    }
  });

  it("system prompt uses the word only to forbid it", () => {
    const lines = buildSystemPrompt().split("\n").filter((line) => CERTIFIED.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- Never call the rules or your answers certified/);
  });

  it("tool descriptions", () => {
    for (const [name, t] of Object.entries(tools)) {
      expect(t.description, name).not.toMatch(CERTIFIED);
    }
  });

  it("describe_program payloads and the prefetch section, for every program", () => {
    const catalog = getCatalog();
    for (const program of catalog.programs) {
      expect(JSON.stringify(describeProgramPayload(program)), program.slug).not.toMatch(CERTIFIED);
    }
    const everyState = catalog.programs.map((p) => p.display_name).join("\n");
    expect(prefetchSection(everyState) ?? "").not.toMatch(CERTIFIED);
  });

  it("compute results, including the auxiliary-slot warning", () => {
    let warned = 0;
    for (const program of getCatalog().programs) {
      const aux = Object.values(program.inputs)
        .flat()
        .find((slot) => slot.aux && slot.dtype === "bool");
      const built = buildRequest({ program, facts: aux ? { [aux.name]: true } : {} });
      const shaped = shapeResult(program, built, {
        metadata: { requested_mode: "fast", actual_mode: "fast", fallback_reason: null },
        results: [],
      } as unknown as Parameters<typeof shapeResult>[2]);
      const json = JSON.stringify(shaped);
      if (json.includes("WARNING")) warned++;
      expect(json, program.slug).not.toMatch(CERTIFIED);
    }
    expect(warned).toBeGreaterThan(0);
  });

  it("page and component source, outside reads of the legacy catalog field", () => {
    const root = path.resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".tsx")) files.push(full);
      }
    };
    walk(path.join(root, "app"));
    walk(path.join(root, "components"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, "utf8").replace(/\.certified_outputs\b/g, "");
      expect(source, path.relative(root, file)).not.toMatch(CERTIFIED);
    }
  });
});
