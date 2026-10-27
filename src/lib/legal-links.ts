const APP_BASE = "https://app.axiom-foundation.org";

/** Link to a corpus document by its citation path (`us/regulation/7/273/4`). */
export function corpusPathToUrl(citationPath: string): string {
  return `${APP_BASE}/${citationPath}`;
}

/** Link a legal id by its structure alone. Server code uses `citationUrl`
 *  (citations.ts) instead, which links the corpus path the rulespec module
 *  declares: the structural path misses the document for most modules
 *  (`us:regulations/7-cfr/273/4` is at us/regulation/7/273/4). This stays
 *  for client components, which can't load the catalog. */
export function legalIdToUrl(id: string): string {
  const [jurisdiction, restPath] = id.split(":");
  if (!jurisdiction || !restPath) return `${APP_BASE}/`;

  const remap: Record<string, string> = {
    statutes: "statute",
    regulations: "regulation",
    policies: "policy",
  };
  const segments = restPath.split("#")[0].split("/");
  if (segments[0] && remap[segments[0]]) segments[0] = remap[segments[0]];
  return corpusPathToUrl(`${jurisdiction}/${segments.join("/")}`);
}
