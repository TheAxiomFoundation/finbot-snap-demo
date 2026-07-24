/**
 * Typed accessor over the generated program catalog.
 *
 * src/lib/generated/catalog.json is produced by scripts/generate-catalog.ts
 * from the pinned rulespec-us program-artifacts release (see
 * artifacts.lock.json). Everything the runtime knows about programs — outputs,
 * input slots, entities, relations, citations — flows through here.
 */
import rawCatalog from "./generated/catalog.json";

export interface CatalogOutput {
  name: string;
  /** Legal id (`us:statutes/7/2017/a#snap_regular_month_allotment`); null for
   *  composition glue rules, which are queried by bare name. */
  id: string | null;
  entity: string;
  semantics: string;
  dtype: string | null;
  unit: string | null;
  period: string | null;
  source: string | null;
  certified: boolean;
  acknowledged_incomplete: boolean;
  /** For judgments: facts in the rule's unconditional conjunction chain with
   *  the values that satisfy them — what must be set for it to hold. */
  requires?: Array<{ slot: string; value: boolean | number | string }>;
  requires_partial?: boolean;
}

export interface CatalogInputSlot {
  name: string;
  dtype: "bool" | "integer" | "decimal" | "date" | "text";
  default: boolean | number | string;
  /** Where the default came from; omitted for the plain dtype heuristic. */
  default_source?: "fixture" | "table_min" | "overlay";
  /** Enum-coded input: value → label mined from the branch each code selects. */
  enum?: Record<string, string>;
  /** Values some rules compare this slot against for equality that the
   *  default does not satisfy. */
  eq_hints?: Array<number | string>;
  /** Bool flag whose branches select different rules/parameters. */
  variant_switch?: boolean;
  /** Not reachable from any certified output — cannot change the headline. */
  aux?: boolean;
}

export interface CatalogRelation {
  name: string;
  related_entity: string | null;
  member_slot: number;
  primary_slot: number;
  used: boolean;
  /** Judgment rules referenced inside aggregators over this relation — the
   *  checks that decide whether a member counts. */
  gate_judgments?: string[];
}

export interface CatalogProgram {
  slug: string;
  jurisdiction: string;
  program_id: string;
  period: string;
  /** Default period for evaluation — differs from `period` when parameter
   *  coverage starts later than the certified period. */
  evaluation_period: string;
  display_name: string;
  description: string;
  spec_path: string;
  primary_entity: string;
  member_entity: string | null;
  entities: string[];
  relations: CatalogRelation[];
  certified_outputs: string[];
  acknowledged_incomplete: string[];
  primary_output: string;
  outputs: CatalogOutput[];
  inputs: Record<string, CatalogInputSlot[]>;
  counts: { derived: number; parameters: number; relations: number };
}

export interface Catalog {
  release_tag: string;
  corpus_sha: string;
  repo: string;
  programs: CatalogProgram[];
  corpus_paths: Record<string, string>;
}

const catalog = rawCatalog as unknown as Catalog;

export function getCatalog(): Catalog {
  return catalog;
}

const bySlug = new Map(catalog.programs.map((p) => [p.slug, p]));

export function getProgram(slug: string): CatalogProgram | undefined {
  return bySlug.get(slug);
}

/** Case-insensitive multi-token search across output names of every program.
 *  All tokens must appear in the output name (any order). */
export function searchOutputs(
  query: string,
  options: { jurisdiction?: string; limit?: number } = {}
): Array<{ program: string; output: CatalogOutput }> {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const limit = options.limit ?? 24;
  const matches: Array<{ program: string; output: CatalogOutput }> = [];
  for (const program of catalog.programs) {
    if (options.jurisdiction && program.jurisdiction !== options.jurisdiction) continue;
    for (const output of program.outputs) {
      const hay = " " + normalize(output.name) + " ";
      if (tokens.every((t) => hay.includes(t))) {
        matches.push({ program: program.slug, output });
        if (matches.length >= limit * 4) return matches.slice(0, limit * 4);
      }
    }
  }
  // Certified outputs first, then shorter (more specific) names.
  matches.sort((a, b) =>
    Number(b.output.certified) - Number(a.output.certified) ||
    a.output.name.length - b.output.name.length
  );
  return matches.slice(0, limit);
}

/** Legal-id-prefix → corpus_citation_path map declared by rulespec modules.
 *  Used by fetch_citation to hit real axiom-corpus documents. */
export function allCorpusPaths(): Record<string, string> {
  return catalog.corpus_paths;
}
