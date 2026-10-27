import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { allCorpusPaths, getCatalog } from "./catalog";
import { corpusPathToUrl } from "./legal-links";

// Corpus documents as the live API served them on 2026-10-26, trimmed.
const REGULATION_273_4 = {
  heading: "Citizenship and alien status",
  body:
    "(a) Household members meeting citizenship or alien status requirements. No person is eligible to participate in the Program unless that person is:\n\n" +
    "(1) A U.S. citizen 1 ;\n\n(6) An individual who is both a qualified alien as defined in paragraph (a)(6)(i) of this section and an eligible alien ...\n\n" +
    "(B) An alien admitted as a refugee under section 207 of the INA;\n\n(C) An alien granted asylum under section 208 of the INA;",
  source_url: "https://www.ecfr.gov/current/title-7/chapter-II/subchapter-C/part-273#p-273.2",
};
const STATUTE_2015_F = {
  heading: "Aliens",
  body:
    "No individual who is a member of a household otherwise eligible to participate in the supplemental nutrition assistance program under this section shall be eligible ... unless he or she is—\n\n" +
    "(1) a resident of the United States; and\n\n(2) either— (A) a citizen or national of the United States; (B) an alien lawfully admitted for permanent residence as an immigrant ...; (C) an alien who has been granted the status of Cuban and Haitian entrant ...; or (D) an individual who lawfully resides in the United States in accordance with a Compact of Free Association ...",
  source_url: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title7-section2015&num=0&edition=prelim",
};

/** Serve `docs` (citation path → document) as the corpus API; record each
 *  requested path. */
function stubCorpus(docs: Record<string, object>): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = decodeURI(String(url).split("/documents/")[1]);
      requested.push(path);
      const doc = docs[path];
      return doc ? new Response(JSON.stringify({ data: doc }), { status: 200 }) : new Response("{}", { status: 404 });
    })
  );
  return requested;
}

// Each test gets a fresh module, so fetchCitation's cache never leaks across.
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const load = () => import("./citations");

describe("fetchCitation on an amended module", () => {
  it("returns the CFR text with the amended statute it applies, at the declared corpus paths", async () => {
    const requested = stubCorpus({ "us/regulation/7/273/4": REGULATION_273_4, "us/statute/7/2015/f": STATUTE_2015_F });
    const { fetchCitation } = await load();
    const c = await fetchCitation("us:regulations/7-cfr/273/4#snap_member_citizenship_or_alien_status_eligible");

    expect(requested).toEqual(["us/regulation/7/273/4", "us/statute/7/2015/f"]);
    expect(c).toMatchObject({
      legal_id: "us:regulations/7-cfr/273/4",
      citation_path: "us/regulation/7/273/4",
      resolution: "rulespec_declared",
      resolved: true,
      url: "https://app.axiom-foundation.org/us/regulation/7/273/4",
      source_url: "https://www.ecfr.gov/current/title-7/section-273.4",
    });
    const amended = c.amended_by!;
    expect(amended).toMatchObject({
      legal_id: "us:statutes/7/2015/f",
      citation: "7 U.S.C. 2015(f)",
      enacted_by: "P.L. 119-21, §10108",
      effective: "2025-07-04",
      applies_from: "2025-08-01",
      heading: "Aliens",
      resolved: true,
      url: "https://app.axiom-foundation.org/us/statute/7/2015/f",
      source_url: STATUTE_2015_F.source_url,
    });
    expect(amended.body_excerpt).toContain("(D) an individual who lawfully resides in the United States in accordance with a Compact of Free Association");
    expect(amended.note).toContain("The 7 CFR 273.4 text above has not been updated for P.L. 119-21, §10108");
    expect(amended.note).toContain("refugees");
    expect(amended.note).toContain("for periods from 2025-08-01");
    expect(amended.evidence.map((e) => e.url)).toContain(
      "https://app.axiom-foundation.org/us/guidance/usda/fns/snap-obbb-alien-eligibility-implementation-memo/page-3"
    );
  });

  it("does not call a revised regulation out of date", async () => {
    const revised = { ...REGULATION_273_4, body: REGULATION_273_4.body.replace("(B) An alien admitted as a refugee under section 207 of the INA;", "") };
    stubCorpus({ "us/regulation/7/273/4": revised, "us/statute/7/2015/f": STATUTE_2015_F });
    const { fetchCitation } = await load();
    const note = (await fetchCitation("us:regulations/7-cfr/273/4")).amended_by!.note;
    expect(note).not.toContain("has not been updated");
    expect(note).toBe(
      "Axiom's encoded 7 CFR 273.4 rules apply 7 U.S.C. 2015(f) as amended by P.L. 119-21, §10108 (effective 2025-07-04) for periods from 2025-08-01."
    );
  });

  it("still names the amendment when the corpus is unreachable, without claiming anything about the text", async () => {
    stubCorpus({});
    const { fetchCitation } = await load();
    const c = await fetchCitation("us:regulations/7-cfr/273/4");
    expect(c).toMatchObject({ resolved: false, resolution: "not_found", body_excerpt: null, citation_path: "us/regulation/7/273/4" });
    expect(c.amended_by).toMatchObject({ legal_id: "us:statutes/7/2015/f", resolved: false, body_excerpt: null });
    expect(c.amended_by!.note).not.toContain("has not been updated");
  });

  it("adds nothing to a module no amendment is registered for", async () => {
    const requested = stubCorpus({ "us/statute/7/2015/f": STATUTE_2015_F });
    const { fetchCitation } = await load();
    const c = await fetchCitation("us:statutes/7/2015/f");
    expect(c.amended_by).toBeUndefined();
    expect(requested).toEqual(["us/statute/7/2015/f"]);
  });
});

describe("checkedSourceUrl", () => {
  const section = fc.record({
    title: fc.integer({ min: 1, max: 50 }),
    part: fc.integer({ min: 1, max: 999 }),
    sec: fc.integer({ min: 1, max: 99 }),
  });

  it("keeps an eCFR anchor that names the cited section", async () => {
    const { checkedSourceUrl } = await load();
    fc.assert(fc.property(section, fc.constantFrom("", "(a)", "(a)(6)"), ({ title, part, sec }, para) => {
      const url = `https://www.ecfr.gov/current/title-${title}/part-${part}#p-${part}.${sec}${para}`;
      expect(checkedSourceUrl(`us/regulation/${title}/${part}/${sec}`, url)).toBe(url);
    }), { seed: 1 });
  });

  it("replaces an anchor that names another section with the cited section's page", async () => {
    const { checkedSourceUrl } = await load();
    fc.assert(fc.property(section, fc.integer({ min: 1, max: 99 }), ({ title, part, sec }, other) => {
      fc.pre(other !== sec);
      const url = `https://www.ecfr.gov/current/title-${title}/part-${part}#p-${part}.${other}`;
      expect(checkedSourceUrl(`us/regulation/${title}/${part}/${sec}`, url)).toBe(
        `https://www.ecfr.gov/current/title-${title}/section-${part}.${sec}`
      );
    }), { seed: 2 });
    expect(checkedSourceUrl("us/regulation/7/273/4", REGULATION_273_4.source_url)).toBe(
      "https://www.ecfr.gov/current/title-7/section-273.4"
    );
    // 273.2 is not 273.20, and 273.20 is not 273.2.
    expect(checkedSourceUrl("us/regulation/7/273/20", "https://www.ecfr.gov/current/title-7/part-273#p-273.2")).toBe(
      "https://www.ecfr.gov/current/title-7/section-273.20"
    );
    expect(checkedSourceUrl("us/regulation/7/273/2", "https://www.ecfr.gov/current/title-7/part-273#p-273.20")).toBe(
      "https://www.ecfr.gov/current/title-7/section-273.2"
    );
  });

  it("leaves other links and other documents alone", async () => {
    const { checkedSourceUrl } = await load();
    expect(checkedSourceUrl("us/regulation/7/273/4", null)).toBeNull();
    expect(checkedSourceUrl("us/statute/7/2015/f", STATUTE_2015_F.source_url)).toBe(STATUTE_2015_F.source_url);
    expect(checkedSourceUrl("us/statute/7/2015", "https://www.ecfr.gov/current/title-7/part-273#p-273.2")).toBe(
      "https://www.ecfr.gov/current/title-7/part-273#p-273.2"
    );
    expect(checkedSourceUrl("us/regulation/7/273/4", "https://www.ecfr.gov/current/title-7/part-273")).toBe(
      "https://www.ecfr.gov/current/title-7/part-273"
    );
  });
});

describe("citationUrl", () => {
  it("links every catalog output's declared corpus document", async () => {
    const { citationUrl } = await load();
    const corpusPaths = allCorpusPaths();
    const ids = [...new Set(getCatalog().programs.flatMap((p) => p.outputs.flatMap((o) => (o.id ? [o.id] : []))))];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const declared = corpusPaths[id.split("#")[0]];
      if (declared) expect(citationUrl(id)).toBe(corpusPathToUrl(declared));
    }
    expect(citationUrl("us:regulations/7-cfr/273/4#snap_member_citizenship_or_alien_status_eligible")).toBe(
      "https://app.axiom-foundation.org/us/regulation/7/273/4"
    );
  });

  it("falls back to the structural link for an undeclared legal id", async () => {
    const { citationUrl } = await load();
    expect(citationUrl("us:statutes/99/1/a")).toBe("https://app.axiom-foundation.org/us/statute/99/1/a");
  });
});
