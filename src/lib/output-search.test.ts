import { describe, expect, it } from "vitest";

import { getCatalog, searchOutputs } from "./catalog";
import { tools } from "./tools";

// list_programs `search` used to keep an output only when every query word
// was in its name. In live gpt-6-luna runs (PR #55) "What is the personal
// exemption amount for 2026?" got "not encoded" in 10 of 10 runs: the model
// searched "personal exemption", "personal exemption amount 151 2026" and
// similar, and `exemption_amount` (26 USC 151(d)) has neither "personal",
// "151" nor "2026" in its name.

const top = (query: string, jurisdiction?: string) => {
  const [first] = searchOutputs(query, { jurisdiction });
  return first && `${first.program}:${first.output.name}`;
};

// The old rule: every word in the name, certified first, then shorter names.
function allWordsInName(query: string, jurisdiction?: string) {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = normalize(query).split(" ");
  return getCatalog().programs
    .filter((p) => !jurisdiction || p.jurisdiction === jurisdiction)
    .flatMap((p) => p.outputs.map((output) => ({ program: p.slug, output })))
    .filter(({ output }) => words.every((w) => ` ${normalize(output.name)} `.includes(w)))
    .sort((a, b) =>
      Number(b.output.certified) - Number(a.output.certified) ||
      a.output.name.length - b.output.name.length
    )
    .slice(0, 24);
}

describe("list_programs output search", () => {
  it.each([
    ["personal exemption"],
    ["personal exemption amount 151 2026"],
    ["exemption amount section 151"],
    ["personal exemption exemption amount section 151"],
    ["Under 26 USC 151, what is the exemption amount for 2026?"],
    ["26 U.S.C. § 151 exemption amount"],
  ])("finds the 26 USC 151 exemption amount for %j", (query) => {
    expect(top(query, "us")).toBe("us-fiit:exemption_amount");
    expect(top(query)).toBe("us-fiit:exemption_amount");
  });

  it.each([
    ["senior deduction", "us"],
    ["standard deduction", "us-ny"],
    ["maximum allotment", "us-co"],
    ["maximum allotment SNAP", "us-co"],
    ["standard", "us-ct"],
    ["deferral", "us-il"],
    ["ctc", "us"],
    ["eitc", undefined],
    ["income", "us"],
  ])("keeps the results of %j (%s), which matched every word before", (query, jurisdiction) => {
    const expected = allWordsInName(query, jurisdiction);
    expect(expected.length).toBeGreaterThan(0);
    expect(searchOutputs(query, { jurisdiction })).toEqual(expected);
  });

  it("keeps certified outputs first", () => {
    expect(top("senior deduction", "us")).toBe("us-fiit:senior_deduction");
    const [first] = searchOutputs("income", { jurisdiction: "us" });
    expect(first.output.certified).toBe(true);
  });

  it("ignores years but keeps a section number after USC", () => {
    expect(searchOutputs("standard deduction 2026", { jurisdiction: "us-ny" }))
      .toEqual(searchOutputs("standard deduction", { jurisdiction: "us-ny" }));
    expect(top("7 USC 2017 allotment", "us-co")).toBe("us-co-snap:snap_regular_month_allotment");
  });

  it("finds outputs named by abbreviation from the spelled-out phrase", () => {
    expect(top("child tax credit phaseout threshold", "us")).toBe("us-fiit:ctc_phaseout_threshold");
    expect(top("earned income tax credit maximum", "us")).toBe("us-fiit:eitc_maximum");
    expect(top("alternative minimum tax exemption", "us")).toBe("us-fiit:amt_exemption");
  });

  it("ranks partial matches by matched words and names the missing ones", () => {
    const matches = searchOutputs("maximum monthly SNAP allotment", { jurisdiction: "us-co" });
    expect(matches[0]).toMatchObject({ output: { name: "snap_maximum_allotment" }, unmatched: ["monthly"] });
    expect(matches.every((m) => m.unmatched && m.unmatched.length <= 2)).toBe(true);
  });

  it("returns nothing when only one or two generic words are in common", () => {
    expect(searchOutputs("income zebra")).toEqual([]);
    // standard_deduction is an input slot in us-fiit, not an output; sharing
    // "income tax" with income_tax_* outputs is not a match.
    expect(searchOutputs("standard deduction 2026 federal income tax", { jurisdiction: "us" })).toEqual([]);
  });

  it("keeps the result limit", () => {
    expect(searchOutputs("income")).toHaveLength(24);
    expect(searchOutputs("income", { limit: 5 })).toHaveLength(5);
  });

  it("returns the missing words to the model as unmatched_terms", async () => {
    // Tool executes take (args, options); list_programs ignores options.
    const search = async (args: object) =>
      (await (tools.list_programs.execute as (args: object, options: object) => Promise<unknown>)(args, {})) as {
        search_matches: Array<{ name: string; unmatched_terms?: string[] }>;
      };
    const partial = await search({ jurisdiction: "us-co", search: "maximum monthly SNAP allotment" });
    expect(partial.search_matches[0]).toMatchObject({ name: "snap_maximum_allotment", unmatched_terms: ["monthly"] });
    const full = await search({ jurisdiction: "us", search: "personal exemption" });
    expect(full.search_matches[0].name).toBe("exemption_amount");
    expect(full.search_matches[0]).not.toHaveProperty("unmatched_terms");
  });
});
