/**
 * Typed accessor over the generated program catalog.
 *
 * src/lib/generated/catalog.json is produced by scripts/generate-catalog.ts
 * from the pinned rulespec-us program-artifacts release (see
 * artifacts.lock.json). Everything the runtime knows about programs — outputs,
 * input slots, entities, relations, citations — flows through here.
 */
import rawCatalog from "./generated/catalog.json";

/** Ordering test in a judgment's `requires`: slot `op` value. */
export type RequirementOp = "gt" | "gte" | "lt" | "lte";

/** One fact a judgment reads: `slot = value`, or with `op` a threshold test
 *  on the slot's real value (`age gte 65`), not a value to set. */
export interface Requirement {
  slot: string;
  value: boolean | number | string;
  op?: RequirementOp;
  /** In `requires_any` only: `slot` names a value the engine computes
   *  (`eitc_child_count gt 0`), not an input. */
  computed?: true;
}

/** An `or` in a judgment's chain, inside `rule`: met when every entry of any
 *  one `any_of` group holds. */
export interface RequirementAlternatives {
  rule: string;
  any_of: Requirement[][];
}

/** A rule's test of a member's age slot: slot `op` value. */
export interface AgeTest {
  slot: string;
  op: RequirementOp;
  value: number;
}

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
   *  the values that satisfy them — what must be set for it to hold. An
   *  entry with `op` is a threshold test on the slot's real value
   *  (`age gte 65`), not a value to set. */
  requires?: Requirement[];
  /** For judgments: each `or` in that chain as alternative groups — e.g.
   *  age_requirements_met: disabled, or younger than the taxpayer and under
   *  19, or younger, a student and under 24. */
  requires_any?: RequirementAlternatives[];
  /** Logic beyond `requires` and `requires_any`. */
  requires_partial?: boolean;
  /** For judgments: sub-judgments read only under `not` or as an `if`
   *  condition; `failed_because` does not follow them. */
  negated_judgments?: string[];
  /** For judgments: the rule's own tests of a member's age slot against a
   *  fixed threshold (`member_age lt 16`). An unstated age is 0, so every
   *  `lt`/`lte` test here holds for it (src/lib/unstated-ages.ts). */
  age_tests?: AgeTest[];
  /** For scalars: judgments whose failure makes this output 0 (us-fiit
   *  `eitc` is `if eitc_allowed then … else 0`). */
  zero_unless?: string[];
  /** Earliest `due` among the annually reissued parameters this output
   *  reaches (see CatalogAnnualUpdate); absent when it reaches none. */
  annual_update_due?: string;
}

/** Parameters reissued every year (classified in src/lib/annual-updates.ts),
 *  grouped by when their next version falls due. A period starting on or
 *  after `due` evaluates values this release may have outdated. */
export interface CatalogAnnualUpdate {
  /** One year after `last_effective_from`. */
  due: string;
  /** Latest encoded effective_from — the version still evaluated past `due`. */
  last_effective_from: string;
  /** `fiscal_year_source`: the source document names a fiscal year
   *  (`.../fy-2026-cola/...`). `annual_versions`: versions recur yearly. */
  basis: "fiscal_year_source" | "annual_versions";
  /** Federal fiscal year of the values in use, when the source names it. */
  fiscal_year?: number;
  /** Source documents (legal ids without the #fragment). */
  sources: string[];
  parameters: string[];
}

export interface CatalogInputSlot {
  name: string;
  dtype: "bool" | "integer" | "decimal" | "date" | "text";
  default: boolean | number | string;
  /** Where the default came from; omitted for the plain dtype heuristic. */
  default_source?: "fixture" | "table_min" | "overlay";
  /** Overlay default that changes on a date: `default` holds for periods
   *  that start before `before`, `otherwise` from then on. Read the default
   *  through slotDefaultAt. */
  default_by_period?: { before: string; otherwise: boolean | number | string };
  /** Enum-coded input: value → label mined from the branch each code selects. */
  enum?: Record<string, string>;
  /** Values some rules compare this slot against for equality that the
   *  default does not satisfy. */
  eq_hints?: Array<number | string>;
  /** Bool flag whose branches select different rules/parameters. */
  variant_switch?: boolean;
  /** Not reachable from any certified output — cannot change the headline. */
  aux?: boolean;
  /** Outputs whose rule chain reads this slot. Listed only for the slots
   *  the app assumes (ASSUMED_MEMBER_SLOTS); empty when no output reads it. */
  read_by?: string[];
  /** Computed allowances the rules add to this slot's value, each with the
   *  on-path bool slots its chain reads (us-az-snap
   *  household_shelter_costs_incurred + az_applied_utility_allowance). The
   *  slot takes the costs the allowance does not stand in for. */
  added_allowances?: Array<{ rule: string; flags: string[] }>;
  /** Flags that claim the added allowance, false by default: the encoding's
   *  own test case sets them all true to get it (us-az-snap: billed
   *  separately, obligated, verified, heating or cooling separately). */
  allowance_claims?: string[];
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
  /** The rules that count members over this relation through gates, one
   *  entry per rule (eitc_child_count through eitc_qualifying_child). */
  aggregations?: CatalogAggregation[];
}

export interface CatalogAggregation {
  rule: string;
  /** Gate judgments read inside the rule's aggregators over the relation. */
  gates: string[];
  /** Gates the rule reads exclusionary (`count(where: gate) == 0`, or under a
   *  `not`): no member holding one is the expected case. */
  exclusionary_gates?: string[];
  /** Gates the rule counts as a number of members rather than testing the
   *  count (`> 0`, `== 0`, all-of): counting none of them gives the rule a
   *  different value, not a failed test. */
  quantity_gates?: string[];
  /** With quantity_gates: the rules that read this rule's value as a number,
   *  directly or through other rules that do (eitc_maximum, through
   *  eitc_capped_child_count). A rule that only compares it
   *  (eitc_demographic_eligible) isn't one. */
  quantity_readers?: string[];
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
  /** Annually reissued parameters reachable from any output; absent when none. */
  annual_updates?: CatalogAnnualUpdate[];
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

/** A slot's default for an evaluation period that starts on `periodStart`
 *  (ISO date; ISO strings compare lexicographically). */
export function slotDefaultAt(slot: CatalogInputSlot, periodStart: string): boolean | number | string {
  const byPeriod = slot.default_by_period;
  return byPeriod && periodStart >= byPeriod.before ? byPeriod.otherwise : slot.default;
}

const normalizeSearchText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Query words that name nothing: question filler (with the "s" of "child's"
 *  and the "t" of "don't"), and citation scaffolding ("26 USC 151" matches
 *  through its numbers). */
const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how",
  "i", "if", "in", "is", "it", "me", "much", "my", "of", "on", "or", "per", "s", "t", "than",
  "that", "the", "this", "to", "under", "what", "with",
  "cfr", "irc", "sec", "section", "subsection", "usc",
]);

/** Phrases people use for terms the encoded names spell differently. Each
 *  becomes one search term that any `|` alternative satisfies. */
const SEARCH_SYNONYMS: Array<[RegExp, string]> = [
  [/\bchild tax credits?\b/g, "ctc|child tax credit"],
  [/\bearned income (?:tax )?credits?\b/g, "eitc|earned income tax credit"],
  [/\balternative minimum tax(?:es)?\b/g, "amt|alternative minimum tax"],
  // 26 USC 151 is headed "personal exemptions"; its rules are named exemption_*.
  [/\bpersonal exemptions?\b/g, "personal exemption|exemption 26 151"],
];

/** A query term: the phrase as typed, and alternative word lists, any one of
 *  which matches when all its words do. */
interface SearchTerm {
  text: string;
  alternatives: string[][];
  /** From SEARCH_SYNONYMS, whose numbers say where to look: any match ranks
   *  as a name match. */
  synonym?: boolean;
}

function searchTerms(query: string): SearchTerm[] {
  let text = query.toLowerCase().replace(/§/g, " section ").replace(/\bu\.?\s*s\.?\s*c\b\.?/g, " usc ");
  const terms: SearchTerm[] = [];
  for (const [pattern, alternatives] of SEARCH_SYNONYMS) {
    text = text.replace(pattern, (phrase) => {
      terms.push({ text: phrase, alternatives: alternatives.split("|").map((a) => a.split(" ")), synonym: true });
      return " ";
    });
  }
  const words = normalizeSearchText(text).split(" ").filter(Boolean);
  const kept = words.filter((word, i) =>
    !SEARCH_STOP_WORDS.has(word) &&
    // A tax or benefit year ("2026") is the period to evaluate, not part of
    // a name; a section number after "USC"/"section" is kept (7 USC 2017).
    !(/^(19|20)\d\d$/.test(word) && !["usc", "section", "sec"].includes(words[i - 1]))
  );
  // A query of nothing but filler still searches its words, as before.
  const chosen = terms.length === 0 && kept.length === 0 ? words : kept;
  for (const word of chosen) terms.push({ text: word, alternatives: [[word]] });
  const seen = new Set<string>();
  return terms.filter((t) => !seen.has(t.text) && seen.add(t.text));
}

/** Every output with its name and legal-id document path normalized for
 *  matching (` exemption amount `, ` us statutes 26 151 `); built once. */
let searchIndex: Array<{ program: CatalogProgram; output: CatalogOutput; name: string; citation: string }> | null = null;

function getSearchIndex() {
  searchIndex ??= catalog.programs.flatMap((program) =>
    program.outputs.map((output) => ({
      program,
      output,
      name: ` ${normalizeSearchText(output.name)} `,
      citation: ` ${normalizeSearchText((output.id ?? output.source ?? "").split("#")[0])} `,
    }))
  );
  return searchIndex;
}

/** 2 when the term matches within the output name, 1 when it needs a number
 *  or letter from the legal id's document path (`us:statutes/26/1/h#...` →
 *  26, 1, h), 0 when it does not match. Words match the name anywhere
 *  ("deduct" finds `..._deduction`); numbers and single letters match whole
 *  words only. */
function termMatch(term: SearchTerm, name: string, citation: string): 0 | 1 | 2 {
  const isCitationPart = (word: string) => word.length === 1 || /^\d+$/.test(word);
  const inName = (word: string) => name.includes(isCitationPart(word) ? ` ${word} ` : word);
  let match: 0 | 1 | 2 = 0;
  for (const words of term.alternatives) {
    if (words.every(inName)) return 2;
    if (words.every((word) => inName(word) || (isCitationPart(word) && citation.includes(` ${word} `)))) {
      match = term.synonym ? 2 : 1;
    }
  }
  return match;
}

/** Case-insensitive search across output names of every program. When some
 *  outputs match every query term, only those are returned: certified first,
 *  then shorter (more specific) names. Otherwise the outputs that match the
 *  most terms are returned with the terms they miss — plus those one term
 *  short of them once they match three or more — but only if that is at
 *  least two terms and half the query, so a word or two in common ("income
 *  tax") does not fill the results. Among equal matches, a number found in
 *  the name ranks above the same number found only in the citation. */
export function searchOutputs(
  query: string,
  options: { jurisdiction?: string; limit?: number } = {}
): Array<{ program: string; output: CatalogOutput; unmatched?: string[] }> {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const limit = options.limit ?? 24;
  const scored: Array<{ program: string; output: CatalogOutput; matched: number[]; score: number; inName: number }> = [];
  let best = 0;
  for (const { program, output, name, citation } of getSearchIndex()) {
    if (options.jurisdiction && program.jurisdiction !== options.jurisdiction) continue;
    const matched = terms.map((term) => termMatch(term, name, citation));
    const score = matched.filter((m) => m > 0).length;
    if (score === 0) continue;
    scored.push({ program: program.slug, output, matched, score, inName: matched.filter((m) => m === 2).length });
    best = Math.max(best, score);
  }
  if (best < terms.length && (best < 2 || best * 2 < terms.length)) return [];
  const floor = best === terms.length || best < 3 ? best : best - 1;
  return scored
    .filter((m) => m.score >= floor)
    .sort((a, b) =>
      b.score - a.score ||
      b.inName - a.inName ||
      Number(b.output.certified) - Number(a.output.certified) ||
      a.output.name.length - b.output.name.length
    )
    .slice(0, limit)
    .map(({ program, output, matched, score }) =>
      score === terms.length
        ? { program, output }
        : { program, output, unmatched: terms.filter((_, i) => matched[i] === 0).map((t) => t.text) }
    );
}

/** Legal-id-prefix → corpus_citation_path map declared by rulespec modules.
 *  Used by fetch_citation to hit real axiom-corpus documents. */
export function allCorpusPaths(): Record<string, string> {
  return catalog.corpus_paths;
}
