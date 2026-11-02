import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Both transports must tag their failures as EngineError: the tool layer
// reads coverage diagnostics (no_formula_version, no_parameter_value) only
// from that class. The transport is chosen from env at module load, so
// each case loads a fresh copy of the module.
const request = { mode: "fast" as const, dataset: { inputs: [], relations: [] }, queries: [] };
const diagnostic = "derived `snap_x` has no formula version at 2025-07-01";
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("engine transport errors", () => {
  it("tags a hosted engine's error status as EngineError", async () => {
    process.env.AXIOM_ENGINE_URL = "https://engine.example.test";
    const fetch = vi.fn(async () => new Response(JSON.stringify({ detail: `axiom-rules-engine exited 1: ${diagnostic}` }), { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    vi.resetModules();
    const engine = await import("./engine");
    const error = await engine.runCompiled("us-ny-snap", request).catch((err: unknown) => err);
    expect(fetch).toHaveBeenCalledWith("https://engine.example.test/run", expect.objectContaining({ method: "POST" }));
    expect(error).toBeInstanceOf(engine.EngineError);
    expect((error as Error).message).toMatch(/^axiom-engine 500: /);
    expect((error as Error).message).toContain(diagnostic);
  });

  it("tags a local engine's non-zero exit as EngineError", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-transport-"));
    try {
      const binary = path.join(dir, "axiom-rules-engine");
      writeFileSync(binary, `#!/bin/sh\ncat >/dev/null\necho '${diagnostic}' >&2\nexit 1\n`);
      chmodSync(binary, 0o755);
      writeFileSync(path.join(dir, "us-ny-snap.compiled.json"), "{}");
      delete process.env.AXIOM_ENGINE_URL;
      process.env.AXIOM_RULES_ENGINE_BINARY = binary;
      process.env.AXIOM_ARTIFACTS_DIR = dir;
      vi.resetModules();
      const engine = await import("./engine");
      const error = await engine.runCompiled("us-ny-snap", request).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(engine.EngineError);
      expect((error as Error).message).toBe(`axiom-rules-engine exited 1: ${diagnostic}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
