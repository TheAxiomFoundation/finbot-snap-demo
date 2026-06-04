export function legalIdToUrl(id: string): string {
  const [jurisdiction, restPath] = id.split(":");
  if (!jurisdiction || !restPath) return "https://app.axiom-foundation.org/";

  if (jurisdiction === "uk") {
    const legislationUrl = ukLegalIdToLegislationUrl(restPath.split("#")[0]);
    if (legislationUrl) return legislationUrl;
  }

  const remap: Record<string, string> = {
    statutes: "statute",
    regulations: "regulation",
    policies: "policy",
  };
  const segments = restPath.split("#")[0].split("/");
  if (segments[0] && remap[segments[0]]) segments[0] = remap[segments[0]];
  return `https://app.axiom-foundation.org/${jurisdiction}/${segments.join("/")}`;
}

function ukLegalIdToLegislationUrl(restPath: string): string | null {
  const [kind, legislationType, year, number, ...tail] = restPath.split("/");
  if (!legislationType || !year || !number) return null;

  const base = `https://www.legislation.gov.uk/${legislationType}/${year}/${number}`;
  if (kind === "statutes") {
    const section = tail[0];
    return section ? `${base}/section/${section}` : base;
  }

  if (kind === "regulations") {
    if (tail[0] === "schedule") return `${base}/${tail.join("/")}`;
    const regulation = tail[0];
    return regulation ? `${base}/regulation/${regulation}` : base;
  }

  return null;
}
