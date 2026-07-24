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
 */
import { allCorpusPaths } from "./catalog";
import { legalIdToUrl } from "./legal-links";

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

async function tryFetch(citationPath: string): Promise<{
  heading: string | null;
  body_excerpt: string | null;
  source_url: string | null;
} | null> {
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
      body_excerpt: body && !isPlaceholderBody(body) ? body.slice(0, 1200) : null,
      source_url: typeof doc?.source_url === "string" ? doc.source_url : null,
    };
  } catch {
    return null;
  }
}

function isPlaceholderBody(body: string): boolean {
  return body.includes(".") && body.replace(/[\s.]+/g, "").length === 0;
}

async function doFetch(base: string): Promise<Citation> {
  const url = legalIdToUrl(base);

  // 1) Authoritative path from the source rulespec, if any.
  const declared = CORPUS_PATH_BY_FILE[base];
  if (declared) {
    const r = await tryFetch(declared);
    if (r) {
      return { legal_id: base, citation_path: declared, url, resolved: true, resolution: "rulespec_declared", ...r };
    }
  }

  // 2) Structural fallback (works for statutes/regulations).
  const structural = structuralCorpusPath(base);
  const r = await tryFetch(structural);
  if (r) {
    return { legal_id: base, citation_path: structural, url, resolved: true, resolution: "structural_fallback", ...r };
  }

  return {
    legal_id: base,
    citation_path: declared ?? structural,
    url,
    heading: null,
    body_excerpt: null,
    source_url: null,
    resolved: false,
    resolution: "not_found",
  };
}
