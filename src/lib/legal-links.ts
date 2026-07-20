export function legalIdToUrl(id: string): string {
  const [jurisdiction, restPath] = id.split(":");
  if (!jurisdiction || !restPath) return "https://app.axiom-foundation.org/";

  const remap: Record<string, string> = {
    statutes: "statute",
    regulations: "regulation",
    policies: "policy",
  };
  const segments = restPath.split("#")[0].split("/");
  if (segments[0] && remap[segments[0]]) segments[0] = remap[segments[0]];
  return `https://app.axiom-foundation.org/${jurisdiction}/${segments.join("/")}`;
}
