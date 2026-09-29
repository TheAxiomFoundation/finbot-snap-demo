import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { modelDisplayName } from "./model-label";

describe("modelDisplayName", () => {
  it("names the models this app ships with", () => {
    expect(modelDisplayName("gpt-5.5")).toBe("GPT-5.5");
    expect(modelDisplayName("gpt-5.5-pro")).toBe("GPT-5.5 Pro");
    expect(modelDisplayName("gpt-5.5-mini")).toBe("GPT-5.5 Mini");
    expect(modelDisplayName("gpt-6")).toBe("GPT-6");
  });

  it("shows unrecognized ids verbatim rather than guessing a name", () => {
    expect(modelDisplayName("gpt-5.5-2026-04-22")).toBe("gpt-5.5-2026-04-22");
    expect(modelDisplayName("o3")).toBe("o3");
  });

  it("never drops the version number or returns empty for a nonempty id", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0), (id) => {
        const label = modelDisplayName(id);
        expect(label.length).toBeGreaterThan(0);
        const version = /^gpt-(\d+(?:\.\d+)*)/i.exec(id.trim())?.[1];
        if (version) expect(label).toContain(version);
      })
    );
  });
});
