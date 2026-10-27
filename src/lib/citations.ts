/**
 * Citation fetcher. Pulls legal text from axiom-foundation.org's public corpus
 * API and turns the result into something the chat surface can render or cite
 * inline.
 *
 * Resolution order for the corpus path:
 *   1. Use the explicit `corpus_citation_path` declared in the source rulespec
 *      module (extracted at catalog-generation time into catalog.json's
 *      corpus_paths map). This is authoritative — for
 *      `us:policies/usda/snap/fy-2026-cola/...` files, the corpus path is
 *      `us/guidance/usda/fns/snap-fy2026-cola/...`, which can never be
 *      derived structurally.
 *   2. Fall back to the structural rewrite (statutes→statute etc.) for
 *      jurisdictions where it happens to line up.
 *
 * When a statute amended the law the cited text states (amendments.ts), the
 * citation also carries the amended provision's text as `amended_by`.
 */
import { allCorpusPaths } from "./catalog";
import { amendmentForModule, type StatutoryAmendment } from "./amendments";
import { corpusPathToUrl, legalIdToUrl } from "./legal-links";

const CORPUS_API_BASE =
  process.env.AXIOM_CORPUS_API ?? "https://axiom-foundation.org/api/axiom";

const CORPUS_PATH_BY_FILE = allCorpusPaths();

export interface Citation {
  legal_id: string;
  citation_path: string;
  heading: string | null;
  body_excerpt: string | null;
  url: string;
  source_url: string | null;
  /** Whether axiom-corpus actually returned body text. */
  resolved: boolean;
  resolution: "rulespec_declared" | "structural_fallback" | "not_found";
  /** The provision as amended, when a statute changed the law this text
   *  states and Axiom's encoded rules apply the amendment. */
  amended_by?: AmendedProvision;
}

export interface AmendedProvision {
  legal_id: string;
  citation: string;
  enacted_by: string;
  effective: string;
  /** First day the encoded rules of the cited module apply the amendment. */
  applies_from: string;
  heading: string | null;
  body_excerpt: string | null;
  url: string;
  source_url: string | null;
  resolved: boolean;
  evidence: Array<{ citation_path: string; excerpt: string; url: string }>;
  note: string;
}

const cache = new Map<string, Promise<Citation>>();

/** Fetch a citation by its base legal ID (no `#rule_name` suffix). */
export function fetchCitation(legalId: string): Promise<Citation> {
  const base = legalId.split("#")[0];
  let inflight = cache.get(base);
  if (inflight) return inflight;
  inflight = doFetch(base);
  cache.set(base, inflight);
  return inflight;
}

/** Link to the corpus document a legal id cites: the path its rulespec
 *  module declares, else the structural rewrite. */
export function citationUrl(legalId: string): string {
  const declared = CORPUS_PATH_BY_FILE[legalId.split("#")[0]];
  return declared ? corpusPathToUrl(declared) : legalIdToUrl(legalId);
}

function structuralCorpusPath(base: string): string {
  const [jurisdiction, rest = ""] = base.split(":");
  const remap: Record<string, string> = {
    statutes: "statute",
    regulations: "regulation",
    policies: "policy",
  };
  const segments = rest.split("/");
  if (segments[0] && remap[segments[0]]) segments[0] = remap[segments[0]];
  return `${jurisdiction}/${segments.join("/")}`;
}

/** A corpus eCFR link whose `#p-<part>.<section>` anchor names another
 *  section is replaced by the cited section's own eCFR page. The 2026-05-10
 *  7 CFR 273 corpus release gives all 16 of its sections the anchor
 *  `#p-273.2`, so 7 CFR 273.4 linked to 273.2. */
export function checkedSourceUrl(citationPath: string, sourceUrl: string | null): string | null {
  if (!sourceUrl) return sourceUrl;
  const cited = /^us\/regulation\/(\d+)\/(\d+)\/(\d+[a-z]?)$/i.exec(citationPath);
  const anchor = /^https:\/\/www\.ecfr\.gov\/[^#]*#p-(\d+\.\d+[a-z]?)(?![0-9a-z])/i.exec(sourceUrl);
  if (!cited || !anchor) return sourceUrl;
  const section = `${cited[2]}.${cited[3]}`;
  return anchor[1] === section ? sourceUrl : `https://www.ecfr.gov/current/title-${cited[1]}/section-${section}`;
}

interface Fetched {
  heading: string | null;
  body: string | null;
  source_url: string | null;
}

async function tryFetch(citationPath: string): Promise<Fetched | null> {
  try {
    const r = await fetch(
      `${CORPUS_API_BASE}/documents/${encodeURI(citationPath)}`,
      { next: { revalidate: 86_400 } }
    );
    if (!r.ok) return null;
    const json = (await r.json()) as {
      rule?: { heading?: string; body?: string; source_url?: string };
      data?: { heading?: string; body?: string; source_url?: string };
      heading?: string;
      body?: string;
      source_url?: string;
    };
    const doc = json.rule ?? json.data ?? json;
    const body = typeof doc?.body === "string" ? doc.body : null;
    return {
      heading: typeof doc?.heading === "string" ? doc.heading : null,
      body: body && !isPlaceholderBody(body) ? body : null,
      source_url: checkedSourceUrl(citationPath, typeof doc?.source_url === "string" ? doc.source_url : null),
    };
  } catch {
    return null;
  }
}

function isPlaceholderBody(body: string): boolean {
  return body.includes(".") && body.replace(/[\s.]+/g, "").length === 0;
}

function citationFrom(
  base: string,
  citationPath: string,
  resolution: Citation["resolution"],
  fetched: Fetched | null
): Citation {
  return {
    legal_id: base,
    citation_path: citationPath,
    url: corpusPathToUrl(citationPath),
    heading: fetched?.heading ?? null,
    body_excerpt: fetched?.body ? fetched.body.slice(0, 1200) : null,
    source_url: fetched?.source_url ?? null,
    resolved: fetched !== null,
    resolution,
  };
}

async function amendedProvision(amendment: StatutoryAmendment, citedBody: string | null): Promise<AmendedProvision> {
  const { provision, enacted_by, effective, encoded_from, module_citation, superseded } = amendment;
  const text = await fetchCitation(provision.legal_id);
  const applies =
    `Axiom's encoded ${module_citation} rules apply ${provision.citation} as amended by ${enacted_by} ` +
    `(effective ${effective}) for periods from ${encoded_from}`;
  // The cited text is period-free; the amended provision is not. The
  // amendment took effect before the encoded rules apply it (FNS: on
  // enactment, for new applicants), so only periods that end before it
  // are plainly under the cited text.
  const earlier = `For periods that end before ${effective}, the ${module_citation} text states the law then in force.`;
  // Call the cited text out of date only while it still says what the
  // amendment changed: a revised regulation drops the passage.
  const note = citedBody?.includes(superseded.passage)
    ? `The ${module_citation} text in the corpus has not been updated for ${enacted_by}, which amended ${provision.citation} ` +
      `effective ${effective}: ${superseded.summary}. ${applies}, so for those periods cite ${provision.citation} as ` +
      `amended (amended_by) as the law the result applied, alongside ${module_citation}. ${earlier}`
    : `${applies}. ${earlier}`;
  return {
    legal_id: provision.legal_id,
    citation: provision.citation,
    enacted_by,
    effective,
    applies_from: encoded_from,
    heading: text.heading,
    body_excerpt: text.body_excerpt,
    url: text.url,
    source_url: text.source_url,
    resolved: text.resolved,
    evidence: amendment.evidence.map((e) => ({ ...e, url: corpusPathToUrl(e.citation_path) })),
    note,
  };
}

async function doFetch(base: string): Promise<Citation> {
  const declared = CORPUS_PATH_BY_FILE[base];
  let citation: Citation;
  let body: string | null;

  // 1) Authoritative path from the source rulespec, if any.
  const fromDeclared = declared ? await tryFetch(declared) : null;
  if (declared && fromDeclared) {
    citation = citationFrom(base, declared, "rulespec_declared", fromDeclared);
    body = fromDeclared.body;
  } else {
    // 2) Structural fallback (works for statutes/regulations).
    const structural = structuralCorpusPath(base);
    const fromStructural = await tryFetch(structural);
    citation = fromStructural
      ? citationFrom(base, structural, "structural_fallback", fromStructural)
      : citationFrom(base, declared ?? structural, "not_found", null);
    body = fromStructural?.body ?? null;
  }

  const amendment = amendmentForModule(base);
  return amendment ? { ...citation, amended_by: await amendedProvision(amendment, body) } : citation;
}
