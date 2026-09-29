/**
 * Plain-language coverage summary for the session notice. Derived from the
 * generated catalog, so the counts follow every release-pin bump with no
 * copy edits: whatever the pinned rulespec-us release encodes is exactly
 * what the notice says the assistant covers.
 */
import type { CatalogProgram } from "./catalog";

type CoverageProgram = Pick<
  CatalogProgram,
  "slug" | "jurisdiction" | "program_id" | "primary_output" | "acknowledged_incomplete"
>;

export interface CoverageGroup {
  key: "snap" | "cash" | "federal-income-tax" | "state-income-tax" | "other";
  /** Short phrase for the one-line summary, e.g. "SNAP in 11 states". */
  phrase: string;
  /** Heading for the per-group detail list, e.g. "SNAP". */
  heading: string;
  /** What the group covers, e.g. state postal codes or program names. */
  members: string[];
  count: number;
}

export interface CoverageSummary {
  total: number;
  /** Programs whose headline output the program spec flags as not fully
   *  encoded (primary_output ∈ acknowledged_incomplete). */
  incomplete: number;
  groups: CoverageGroup[];
}

const isState = (jurisdiction: string) => /^us-[a-z]{2}$/.test(jurisdiction);
const postal = (jurisdiction: string) => jurisdiction.slice(3).toUpperCase();
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

interface GroupSpec {
  key: Exclude<CoverageGroup["key"], "other">;
  heading: string;
  match: (p: CoverageProgram) => boolean;
  phrase: (n: number) => string;
}

// Checked in order; a program lands in the first group it matches, and
// anything unmatched falls through to "other", so the groups always
// partition the catalog.
const GROUP_SPECS: GroupSpec[] = [
  {
    key: "snap",
    heading: "SNAP",
    match: (p) => p.program_id === "snap" && isState(p.jurisdiction),
    phrase: (n) => `SNAP in ${n} ${plural(n, "state", "states")}`,
  },
  {
    key: "cash",
    heading: "Cash assistance (TANF)",
    match: (p) => (p.program_id === "tanf" || p.program_id === "tca") && isState(p.jurisdiction),
    phrase: (n) => `cash assistance (TANF) in ${n} ${plural(n, "state", "states")}`,
  },
  {
    key: "federal-income-tax",
    heading: "Federal income tax",
    match: (p) => p.program_id === "fiit" && p.jurisdiction === "us",
    phrase: () => "federal income tax",
  },
  {
    key: "state-income-tax",
    heading: "State income tax",
    match: (p) => p.program_id === "income-tax" && isState(p.jurisdiction),
    phrase: (n) => `${n} state income ${plural(n, "tax", "taxes")}`,
  },
];

export function summarizeCoverage<P extends CoverageProgram>(
  programs: readonly P[],
  displayName: (p: P) => string = (p) => p.slug
): CoverageSummary {
  const buckets = new Map<CoverageGroup["key"], P[]>();
  for (const program of programs) {
    const spec = GROUP_SPECS.find((s) => s.match(program));
    const key = spec?.key ?? "other";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(program);
  }

  const groups: CoverageGroup[] = [];
  for (const spec of GROUP_SPECS) {
    const members = buckets.get(spec.key);
    if (!members?.length) continue;
    groups.push({
      key: spec.key,
      heading: spec.heading,
      phrase: spec.phrase(members.length),
      members:
        spec.key === "federal-income-tax"
          ? members.map(displayName)
          : [...new Set(members.map((p) => postal(p.jurisdiction)))].sort(),
      count: members.length,
    });
  }
  const other = buckets.get("other");
  if (other?.length) {
    groups.push({
      key: "other",
      heading: "Other",
      phrase: `${other.length} other ${plural(other.length, "program", "programs")}`,
      members: other.map(displayName).sort(),
      count: other.length,
    });
  }

  return {
    total: programs.length,
    incomplete: programs.filter((p) => p.acknowledged_incomplete.includes(p.primary_output)).length,
    groups,
  };
}

/** "SNAP in 11 states, cash assistance (TANF) in 17 states, federal income
 *  tax, 2 state income taxes, and 3 other programs". */
export function coverageSentence(summary: CoverageSummary): string {
  const phrases = summary.groups.map((g) => g.phrase);
  if (phrases.length <= 1) return phrases.join("");
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}
