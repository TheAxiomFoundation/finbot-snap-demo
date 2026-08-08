/**
 * Build-time catalog generator.
 *
 * Generalizes the old scripts/regenerate-co-snap-base.py across every program
 * in the pinned rulespec-us program-artifacts release. For each compiled
 * artifact it:
 *
 *   - lists every derived rule as a queryable output (legal id when present;
 *     composition glue rules are addressable by bare name);
 *   - walks the compiled IR to find every `{kind: "input"}` reference, grouped
 *     by entity scope (relation aggregators flip scope to the related entity);
 *   - infers each input's dtype from surrounding expression context and picks
 *     a default (fixture-mined where a composition .test.yaml exists in the
 *     corpus, dtype heuristic otherwise);
 *   - infers each relation's related entity by a 3-signal vote (derived refs
 *     inside aggregator bodies → their rule's entity; inputs shared between
 *     scopes; most-common non-primary entity fallback — warned);
 *   - reads `acknowledged_incomplete` from the program spec in the corpus
 *     checkout and corpus citation paths from every rulespec module.
 *
 * Inputs:  engine/artifacts/ (run `bun run artifacts:fetch` first) and a
 *          one-shot corpus tarball cached under .cache/ at the pinned sha.
 * Output:  src/lib/generated/catalog.json (committed).
 *
 * Run at pin-bump time: bun run artifacts:fetch && bun run catalog:generate
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { CATALOG_OVERLAY, GLOBAL_DEFAULT_OVERRIDES } from "../src/lib/catalog-overlay";

/** Global override keys that matched at least one slot across all programs. */
const matchedGlobalOverrides = new Set<string>();

const ROOT = path.resolve(path.join(import.meta.dirname ?? __dirname, ".."));
const ARTIFACTS_DIR = path.join(ROOT, "engine", "artifacts");
const CACHE_DIR = path.join(ROOT, ".cache");
const OUTPUT_PATH = path.join(ROOT, "src", "lib", "generated", "catalog.json");

// ---------------------------------------------------------------------------
// Types mirrored into src/lib/catalog.ts. Keep in sync.
// ---------------------------------------------------------------------------

interface CatalogOutput {
  name: string;
  /** Legal id, e.g. "us:statutes/7/2017/a#snap_regular_month_allotment".
   *  Null for composition glue rules — query those by bare name. */
  id: string | null;
  entity: string;
  semantics: string;
  dtype: string | null;
  unit: string | null;
  period: string | null;
  source: string | null;
  certified: boolean;
  acknowledged_incomplete: boolean;
  /** For judgments: input facts in the rule's unconditional conjunction
   *  chain (through derived refs, depth-capped) with the values that satisfy
   *  them. What the LLM needs to make the judgment hold — e.g. the CTC
   *  qualifying-child SSN facts. Disjunctive/conditional branches are not
   *  descended; `requires_partial` marks truncation. */
  requires?: Array<{ slot: string; value: boolean | number | string }>;
  requires_partial?: boolean;
}

interface CatalogInputSlot {
  name: string;
  dtype: "bool" | "integer" | "decimal" | "date" | "text";
  default: boolean | number | string;
  /** Where the default came from; omitted for the plain dtype heuristic. */
  default_source?: "fixture" | "table_min" | "overlay";
  /** Enum-coded input: value → label mined from the branch each code selects
   *  (e.g. filing_status 1 → "income_tax_bracket_thresholds_joint"). */
  enum?: Record<string, string>;
  /** Non-bool values some rules compare this slot against for equality and
   *  the default does not satisfy (e.g. taxable_year_months = 12). */
  eq_hints?: Array<number | string>;
  /** Bool flag whose branches select different rules/parameters — a
   *  law-variant or regime switch, not a household fact. */
  variant_switch?: boolean;
  /** Not reachable from any certified output — setting it cannot change the
   *  headline numbers (diagnostic/auxiliary chains only). */
  aux?: boolean;
}

interface CatalogRelation {
  name: string;
  /** Entity on the "many" side (e.g. Person). Null when inference failed. */
  related_entity: string | null;
  /** Tuple slot the related/member entity id occupies. */
  member_slot: number;
  /** Tuple slot the primary entity id occupies. */
  primary_slot: number;
  /** Whether any aggregator in the IR actually reads this relation. */
  used: boolean;
  /** Judgment rules referenced inside aggregators over this relation — the
   *  checks that decide whether a member counts (e.g. ctc_qualifying_child). */
  gate_judgments?: string[];
}

interface CatalogProgram {
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
  /** Input slots grouped by entity scope. */
  inputs: Record<string, CatalogInputSlot[]>;
  counts: { derived: number; parameters: number; relations: number };
}

// ---------------------------------------------------------------------------
// Display metadata — jurisdiction-level only, never per-program.
// ---------------------------------------------------------------------------

const STATE_NAMES: Record<string, string> = {
  us: "Federal", "us-ak": "Alaska", "us-al": "Alabama", "us-ar": "Arkansas",
  "us-az": "Arizona", "us-ca": "California", "us-co": "Colorado",
  "us-ct": "Connecticut", "us-dc": "District of Columbia", "us-de": "Delaware",
  "us-fl": "Florida", "us-ga": "Georgia", "us-hi": "Hawaii", "us-ia": "Iowa",
  "us-id": "Idaho", "us-il": "Illinois", "us-in": "Indiana", "us-ks": "Kansas",
  "us-ky": "Kentucky", "us-la": "Louisiana", "us-ma": "Massachusetts",
  "us-md": "Maryland", "us-me": "Maine", "us-mi": "Michigan",
  "us-mn": "Minnesota", "us-mo": "Missouri", "us-ms": "Mississippi",
  "us-mt": "Montana", "us-nc": "North Carolina", "us-nd": "North Dakota",
  "us-ne": "Nebraska", "us-nh": "New Hampshire", "us-nj": "New Jersey",
  "us-nm": "New Mexico", "us-nv": "Nevada", "us-ny": "New York",
  "us-oh": "Ohio", "us-ok": "Oklahoma", "us-or": "Oregon",
  "us-pa": "Pennsylvania", "us-ri": "Rhode Island", "us-sc": "South Carolina",
  "us-sd": "South Dakota", "us-tn": "Tennessee", "us-tx": "Texas",
  "us-ut": "Utah", "us-va": "Virginia", "us-vt": "Vermont",
  "us-wa": "Washington", "us-wi": "Wisconsin", "us-wv": "West Virginia",
  "us-wy": "Wyoming",
};

const PROGRAM_NAMES: Record<string, string> = {
  snap: "SNAP",
  tanf: "TANF",
  tca: "TCA (Temporary Cash Assistance)",
  fiit: "Individual Income Tax",
  "income-tax": "Income Tax",
  "oasdi-wage-tax": "OASDI Wage Tax",
  scretd: "Senior Citizens Real Estate Tax Deferral",
};

function programDisplayName(jurisdiction: string, programId: string): string {
  const state = STATE_NAMES[jurisdiction] ?? jurisdiction;
  const program =
    PROGRAM_NAMES[programId] ?? programId.replace(/-/g, " ").toUpperCase();
  return `${state} ${program}`;
}

// ---------------------------------------------------------------------------
// IR walk
// ---------------------------------------------------------------------------

type IRNode = Record<string, unknown>;

const AGGREGATOR_INNER_KEYS = ["where", "value", "expr"] as const;

function isAggregator(node: IRNode): boolean {
  return typeof node.relation === "string" && typeof node.kind === "string";
}

/** Yield every node in the IR with its parent and current entity scope.
 *  `relationEntity` maps relation name → related entity; descending into an
 *  aggregator's inner expression flips scope to that entity. */
function* walkRefs(
  node: unknown,
  parent: IRNode | null,
  scope: string,
  relationEntity: Map<string, string>
): Generator<{ node: IRNode; parent: IRNode | null; scope: string }> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walkRefs(child, parent, scope, relationEntity);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as IRNode;
  yield { node: n, parent, scope };
  if (isAggregator(n)) {
    const inner = relationEntity.get(n.relation as string) ?? scope;
    for (const key of AGGREGATOR_INNER_KEYS) {
      if (key in n) yield* walkRefs(n[key], n, inner, relationEntity);
    }
    return;
  }
  for (const value of Object.values(n)) {
    yield* walkRefs(value, n, scope, relationEntity);
  }
}

// ---------------------------------------------------------------------------
// Dtype inference — port of the Python infer_dtype ranking.
// ---------------------------------------------------------------------------

const NUMERIC_PARENT_KINDS = new Set([
  "add", "sub", "mul", "div", "min", "max", "floor", "ceil", "ratio",
  "currency", "abs", "round", "sum", "sum_related", "parameter_lookup",
]);
const BOOL_EXPR_KINDS = new Set(["and", "or", "not", "comparison", "any_where", "all_where"]);
const DATE_PARENT_KINDS = new Set([
  "date_add_days", "days_between", "period_start", "period_end",
]);
const DTYPE_RANK: Record<string, number> = {
  integer: 5, decimal: 4, date: 3, text: 2, bool: 1,
};

/** Static result dtype of an expression, where determinable. Used to type
 *  inputs that sit in `if` branches: the sibling branch's type is the best
 *  signal (e.g. `if itemizes then salt+misc else input(standard_deduction)` —
 *  standard_deduction must be numeric or the engine's branch-type check
 *  rejects the whole rule). */
function staticDtypeOf(
  node: unknown,
  ruleDtypes: Map<string, string | null | undefined>,
  depth = 0
): CatalogInputSlot["dtype"] | null {
  if (depth > 6 || node === null || typeof node !== "object" || Array.isArray(node)) return null;
  const n = node as IRNode;
  const kind = n.kind as string | undefined;
  if (!kind) return null;
  if (kind === "literal") {
    const sub = (n.value as IRNode | undefined)?.kind as string | undefined;
    if (sub === "integer" || sub === "decimal" || sub === "bool" || sub === "text" || sub === "date") return sub;
    return null;
  }
  if (kind === "count_related") return "integer";
  if (NUMERIC_PARENT_KINDS.has(kind)) return "decimal";
  if (BOOL_EXPR_KINDS.has(kind)) return "bool";
  if (kind === "if") {
    return (
      staticDtypeOf(n.then_expr, ruleDtypes, depth + 1) ??
      staticDtypeOf(n.else_expr, ruleDtypes, depth + 1)
    );
  }
  if (kind === "derived") {
    const dtype = ruleDtypes.get(n.name as string);
    if (dtype === "integer" || dtype === "decimal" || dtype === "date" || dtype === "text") return dtype;
    if (dtype === "judgment" || dtype === "bool") return "bool";
    return null;
  }
  return null;
}

function inferDtype(
  parent: IRNode | null,
  inputNode: IRNode,
  ruleDtypes: Map<string, string | null | undefined>
): CatalogInputSlot["dtype"] {
  const kind = parent?.kind as string | undefined;
  if (kind === "and" || kind === "or" || kind === "not") return "bool";
  if (kind && DATE_PARENT_KINDS.has(kind)) return "date";
  if (kind === "if" && parent) {
    if (parent.condition === inputNode) return "bool";
    // Type the branch from its sibling — the engine requires both branches to
    // share a dtype.
    const sibling = parent.then_expr === inputNode ? parent.else_expr : parent.then_expr;
    const siblingType = staticDtypeOf(sibling, ruleDtypes);
    if (siblingType) return siblingType;
  }
  if (kind === "comparison" && parent) {
    // Read the literal type of the *other* operand, e.g. `member_age >= 60`.
    for (const side of ["left", "right"]) {
      const operand = parent[side];
      if (operand === inputNode || typeof operand !== "object" || operand === null) continue;
      const sibling = operand as IRNode;
      if (sibling.kind === "literal") {
        const inner = (sibling.value ?? {}) as IRNode;
        const sub = inner.kind as string;
        if (sub === "integer" || sub === "decimal" || sub === "bool" || sub === "text" || sub === "date") {
          return sub;
        }
      }
    }
    // Non-literal siblings: use the sibling expression's static type, then
    // fall back to "ordering comparisons are numeric"
    // (`member_weekly_work_hours >= param(...)`).
    for (const side of ["left", "right"]) {
      const operand = parent[side];
      if (operand === inputNode) continue;
      const siblingType = staticDtypeOf(operand, ruleDtypes);
      if (siblingType) return siblingType;
    }
    const op = parent.op as string | undefined;
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") return "decimal";
  }
  if (kind && NUMERIC_PARENT_KINDS.has(kind)) return "decimal";
  return "bool";
}

function defaultFor(dtype: CatalogInputSlot["dtype"], periodStart: string): boolean | number | string {
  switch (dtype) {
    case "bool": return false;
    case "integer": return 0;
    case "decimal": return 0;
    case "date": return periodStart;
    case "text": return "";
  }
}

// ---------------------------------------------------------------------------
// Corpus checkout (tarball at the pinned sha)
// ---------------------------------------------------------------------------

function ensureCorpusCheckout(lock: { repo: string; corpus_sha: string }): string {
  const repoName = lock.repo.split("/")[1];
  const dir = path.join(CACHE_DIR, `${repoName}-${lock.corpus_sha}`);
  if (existsSync(dir)) return dir;
  console.log(`==> downloading corpus tarball @ ${lock.corpus_sha.slice(0, 12)}`);
  const tarPath = path.join(CACHE_DIR, `${repoName}-${lock.corpus_sha}.tar.gz`);
  execFileSync("mkdir", ["-p", CACHE_DIR]);
  execFileSync("curl", [
    "-sL",
    `https://codeload.github.com/${lock.repo}/tar.gz/${lock.corpus_sha}`,
    "-o", tarPath,
  ]);
  execFileSync("tar", ["-xzf", tarPath, "-C", CACHE_DIR]);
  if (!existsSync(dir)) throw new Error(`tarball extraction did not produce ${dir}`);
  return dir;
}

/** Walk every rulespec YAML in the corpus and map legal-id prefixes
 *  (`us-co:regulations/10-ccr-2506-1/4.207.3`) onto declared
 *  corpus_citation_path values. Regex extraction — the fields are simple
 *  scalars and full YAML parsing of ~10k files is needlessly slow. */
function collectCorpusPaths(corpusDir: string): Record<string, string> {
  const corpusPaths: Record<string, string> = {};
  const jurisdictions = readdirSync(corpusDir).filter((name) =>
    /^us(-[a-z]{2})?$/.test(name) && statSync(path.join(corpusDir, name)).isDirectory()
  );
  const walk = (dir: string, visit: (file: string) => void) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, visit);
      else if (entry.name.endsWith(".yaml") && !entry.name.endsWith(".test.yaml")) visit(p);
    }
  };
  for (const jurisdiction of jurisdictions) {
    const root = path.join(corpusDir, jurisdiction);
    walk(root, (file) => {
      const text = readFileSync(file, "utf8");
      if (!/^format:\s*rulespec\/v1/m.test(text)) return;
      let match = text.match(/^\s*corpus_citation_path:\s*["']?([^\s"'#]+)/m);
      if (!match) {
        // corpus_citation_paths: [a, b] or a dash list — take the first entry.
        const listMatch = text.match(
          /^\s*corpus_citation_paths:\s*(?:\[\s*["']?([^\s,\]"']+)|\n\s*-\s*["']?([^\s"'#]+))/m
        );
        if (listMatch) match = [listMatch[0], listMatch[1] ?? listMatch[2]];
      }
      if (!match) return;
      const rel = path.relative(root, file).replace(/\.yaml$/, "");
      corpusPaths[`${jurisdiction}:${rel}`] = match[1];
    });
  }
  return corpusPaths;
}

/** Mine dtypes + defaults from a composition test fixture's first case.
 *  Returns {local_input_name: {dtype, default}}. */
function mineFixture(fixturePath: string): Map<string, { dtype: CatalogInputSlot["dtype"]; default: boolean | number | string }> {
  const mined = new Map<string, { dtype: CatalogInputSlot["dtype"]; default: boolean | number | string }>();
  const doc = YAML.parse(readFileSync(fixturePath, "utf8"));
  const firstCase = Array.isArray(doc) ? doc[0] : doc;
  if (!firstCase || typeof firstCase !== "object") return mined;

  const jsDtype = (v: unknown): CatalogInputSlot["dtype"] => {
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "decimal";
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
    return "text";
  };
  const collect = (scope: Record<string, unknown>) => {
    for (const [fullId, value] of Object.entries(scope)) {
      if (fullId.includes("#input.")) {
        const local = fullId.split("#input.")[1];
        if (!mined.has(local) && (typeof value === "boolean" || typeof value === "number" || typeof value === "string")) {
          mined.set(local, { dtype: jsDtype(value), default: value });
        }
      } else if (fullId.includes("#relation.") && Array.isArray(value)) {
        for (const member of value) {
          if (member && typeof member === "object") collect(member as Record<string, unknown>);
        }
      }
    }
  };
  const input = (firstCase as Record<string, unknown>).input;
  if (input && typeof input === "object") collect(input as Record<string, unknown>);
  return mined;
}

// ---------------------------------------------------------------------------
// Per-program analysis
// ---------------------------------------------------------------------------

interface ManifestProgram {
  jurisdiction: string;
  program_id: string;
  period: string;
  spec_path: string;
  outputs: string[];
  artifact: string;
  artifact_sha256: string;
  counts: { derived: number; parameters: number; relations: number };
}

interface DerivedRule {
  id: string | null;
  name: string;
  entity?: string;
  dtype?: string | null;
  unit?: string | null;
  period?: string | null;
  source?: string | null;
  semantics?: string;
  expr?: unknown;
}

const PRIMARY_OUTPUT_SUFFIX =
  /(^|_)(benefit|allotment|award|payment|tax|credit|grant|amount)$/;

function analyzeProgram(
  manifestProgram: ManifestProgram,
  corpusDir: string,
  warnings: string[]
): CatalogProgram {
  const slug = manifestProgram.artifact.replace(/\.compiled\.json$/, "");
  const artifact = JSON.parse(
    readFileSync(path.join(ARTIFACTS_DIR, manifestProgram.artifact), "utf8")
  );
  const program = artifact.program as {
    module?: { summary?: string };
    relations: Array<{ name: string; arity: number }>;
    parameters: unknown[];
    derived: DerivedRule[];
  };
  const rules = program.derived;
  const ruleByName = new Map(rules.map((r) => [r.name, r]));
  const overlay = CATALOG_OVERLAY[slug] ?? {};
  const warn = (msg: string) => warnings.push(`${slug}: ${msg}`);

  // -- Certified outputs -----------------------------------------------------
  const certified = new Set(manifestProgram.outputs);
  for (const name of certified) {
    if (!ruleByName.has(name)) warn(`certified output ${name} not found among derived rules`);
  }

  // -- acknowledged_incomplete + fixtures from the program spec ---------------
  const specFile = path.join(corpusDir, manifestProgram.spec_path);
  let acknowledgedIncomplete: string[] = [];
  const fixtureCandidates: string[] = [];
  if (existsSync(specFile)) {
    const spec = YAML.parse(readFileSync(specFile, "utf8")) as {
      acknowledged_incomplete?: string[];
      scope?: Record<string, string[]>;
    };
    acknowledgedIncomplete = spec.acknowledged_incomplete ?? [];
    // Composition-style fixtures (full coherent scenarios) sit beside scope
    // entries that look like fiscal-year compositions, in the jurisdiction dir.
    for (const entries of Object.values(spec.scope ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== "string" || !/fy-\d{4}/.test(entry)) continue;
        const fixture = path.join(corpusDir, manifestProgram.jurisdiction, `${entry}.test.yaml`);
        if (existsSync(fixture)) fixtureCandidates.push(fixture);
      }
    }
  } else {
    warn(`spec file missing in corpus checkout: ${manifestProgram.spec_path}`);
  }

  // -- Relation related-entity inference (3-signal vote) ---------------------
  // Signal 1: derived refs inside aggregator bodies → their rule's entity.
  // Signal 2: inputs inside aggregator bodies that also appear directly in
  //           rules of some other entity → that entity.
  // Signal 3 (fallback, warned): most common non-primary entity in the program.
  const directInputEntities = new Map<string, Set<string>>(); // input name → entities whose rules use it directly
  for (const rule of rules) {
    const entity = rule.entity ?? "Household";
    for (const { node, scope } of walkRefs(rule.expr, null, entity, new Map())) {
      // walkRefs without relation entities keeps aggregator-inner scope at the
      // outer entity — filter those out by skipping nodes under aggregators is
      // complex; instead only record refs whose scope equals the rule entity
      // AND that aren't inside an aggregator. Simplification: aggregator-inner
      // refs are few; the vote tolerates the noise.
      if (node.kind === "input" && scope === entity) {
        const name = node.name as string;
        if (!directInputEntities.has(name)) directInputEntities.set(name, new Set());
        directInputEntities.get(name)!.add(entity);
      }
    }
  }

  const relationVotes = new Map<string, Map<string, number>>();
  const relationSlots = new Map<string, { member_slot: number; primary_slot: number }>();
  const relationOuterEntities = new Map<string, Set<string>>();
  const relationBodyInputs = new Map<string, Set<string>>();
  const relationGateJudgments = new Map<string, Set<string>>();
  const aggregatorRefs = (node: unknown): Array<{ kind: string; name: string }> => {
    const refs: Array<{ kind: string; name: string }> = [];
    const visit = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (n === null || typeof n !== "object") return;
      const obj = n as IRNode;
      if ((obj.kind === "input" || obj.kind === "derived") && typeof obj.name === "string") {
        refs.push({ kind: obj.kind as string, name: obj.name });
      }
      Object.values(obj).forEach(visit);
    };
    visit(node);
    return refs;
  };

  for (const rule of rules) {
    const outerEntity = rule.entity ?? "Household";
    for (const { node } of walkRefs(rule.expr, null, outerEntity, new Map())) {
      if (!isAggregator(node)) continue;
      const relation = node.relation as string;
      if (!relationSlots.has(relation)) {
        relationSlots.set(relation, {
          member_slot: (node.related_slot as number) ?? 0,
          primary_slot: (node.current_slot as number) ?? 1,
        });
      }
      if (!relationVotes.has(relation)) relationVotes.set(relation, new Map());
      if (!relationOuterEntities.has(relation)) relationOuterEntities.set(relation, new Set());
      relationOuterEntities.get(relation)!.add(outerEntity);
      if (!relationBodyInputs.has(relation)) relationBodyInputs.set(relation, new Set());
      const votes = relationVotes.get(relation)!;
      if (!relationGateJudgments.has(relation)) relationGateJudgments.set(relation, new Set());
      for (const key of AGGREGATOR_INNER_KEYS) {
        if (!(key in node)) continue;
        for (const ref of aggregatorRefs(node[key])) {
          if (ref.kind === "input") relationBodyInputs.get(relation)!.add(ref.name);
          if (ref.kind === "derived") {
            const target = ruleByName.get(ref.name);
            if (target && (target.semantics === "judgment" || target.dtype === "judgment")) {
              relationGateJudgments.get(relation)!.add(ref.name);
            }
          }
          if (ref.kind === "derived") {
            const target = ruleByName.get(ref.name);
            const entity = target?.entity;
            if (entity && entity !== outerEntity) {
              votes.set(entity, (votes.get(entity) ?? 0) + 2); // strong signal
            }
          } else {
            for (const entity of directInputEntities.get(ref.name) ?? []) {
              if (entity !== outerEntity) votes.set(entity, (votes.get(entity) ?? 0) + 1);
            }
          }
        }
      }
    }
  }

  // Entity frequency across rules — used for fallback votes and primary entity.
  const entityFrequency = new Map<string, number>();
  for (const rule of rules) {
    const entity = rule.entity ?? "Household";
    entityFrequency.set(entity, (entityFrequency.get(entity) ?? 0) + 1);
  }

  // -- Primary output + entity ----------------------------------------------
  const certifiedList = manifestProgram.outputs;
  let primaryOutput = overlay.primary_output;
  if (primaryOutput && !ruleByName.has(primaryOutput)) {
    warn(`overlay primary_output ${primaryOutput} not found; falling back to heuristic`);
    primaryOutput = undefined;
  }
  if (!primaryOutput) {
    const exact = certifiedList.find(
      (name) => name === manifestProgram.program_id.replace(/-/g, "_")
    );
    const suffixMatch = [...certifiedList]
      .reverse()
      .find((name) => PRIMARY_OUTPUT_SUFFIX.test(name) && ruleByName.get(name)?.semantics !== "judgment");
    primaryOutput = exact ?? suffixMatch ?? certifiedList[certifiedList.length - 1];
  }
  const primaryRule = ruleByName.get(primaryOutput);
  const primaryEntity =
    primaryRule?.entity ??
    [...entityFrequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    "Household";

  const mostCommonNonPrimary = [...entityFrequency.entries()]
    .filter(([entity]) => entity !== primaryEntity)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  // Relations declared under different legal ids frequently share a short
  // name (e.g. `us:statutes/7/2012/j#relation.member_of_household` and
  // `us:policies/usda/snap/state-plan-composition#relation.member_of_household`)
  // and connect the same entity pair — pool their votes.
  const shortName = (name: string) => name.split("#").pop()!.replace(/^relation\./, "");
  const pooledVotes = new Map<string, Map<string, number>>();
  for (const [relation, votes] of relationVotes) {
    const key = shortName(relation);
    if (!pooledVotes.has(key)) pooledVotes.set(key, new Map());
    const pool = pooledVotes.get(key)!;
    for (const [entity, count] of votes) pool.set(entity, (pool.get(entity) ?? 0) + count);
  }

  const relations: CatalogRelation[] = program.relations.map((rel) => {
    const votes = pooledVotes.get(shortName(rel.name));
    const used = relationSlots.has(rel.name);
    let relatedEntity: string | null = null;
    const outerEntities = relationOuterEntities.get(rel.name) ?? new Set<string>();
    if (votes && votes.size > 0) {
      relatedEntity = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    } else if (used) {
      // Entity-prefix signal: aggregated input names conventionally start
      // with a token of the related entity's name, e.g. `pay_amount` under a
      // relation to Payment records.
      const bodyInputs = relationBodyInputs.get(rel.name) ?? new Set<string>();
      const prefixHit = [...entityFrequency.keys()].find((entity) => {
        if (outerEntities.has(entity)) return false;
        const lower = entity.toLowerCase();
        return [...bodyInputs].some((input) => {
          const firstToken = input.split("_")[0];
          return firstToken.length >= 3 && lower.startsWith(firstToken);
        });
      });
      // Name-convention signal: corpus relations that enumerate people use
      // member/person/child/dependent naming. Guarded so a Person-side
      // aggregation over its own records (`pays_received_to_date_by_person`)
      // doesn't self-match. Warned either way so pin bumps get a human look.
      if (prefixHit) {
        relatedEntity = prefixHit;
        warn(`relation ${rel.name}: related entity by input-prefix → ${relatedEntity}`);
      } else if (
        /member|person|individual|child|dependent/.test(shortName(rel.name)) &&
        entityFrequency.has("Person") &&
        !outerEntities.has("Person")
      ) {
        relatedEntity = "Person";
        warn(`relation ${rel.name}: related entity by name convention → Person`);
      } else if (mostCommonNonPrimary) {
        relatedEntity = mostCommonNonPrimary;
        warn(`relation ${rel.name}: related entity by fallback vote → ${relatedEntity}`);
      }
    }
    const slots = relationSlots.get(rel.name) ?? { member_slot: 0, primary_slot: 1 };
    const gates = [...(relationGateJudgments.get(rel.name) ?? [])].sort();
    return {
      name: rel.name,
      related_entity: relatedEntity,
      used,
      ...slots,
      ...(gates.length > 0 && { gate_judgments: gates }),
    };
  });

  const memberEntity =
    relations.filter((r) => r.used && r.related_entity)
      .map((r) => r.related_entity!)
      .sort(
        (a, b) =>
          relations.filter((r) => r.related_entity === b && r.used).length -
          relations.filter((r) => r.related_entity === a && r.used).length
      )[0] ?? null;
  const relationEntityMap = new Map<string, string>();
  for (const rel of relations) {
    if (rel.related_entity) relationEntityMap.set(rel.name, rel.related_entity);
  }

  // -- Input slots by entity scope -------------------------------------------
  const ruleDtypes = new Map<string, string | null | undefined>(
    rules.map((r) => [r.name, r.dtype ?? (r.semantics === "judgment" ? "judgment" : null)])
  );
  const dtypeCandidates = new Map<string, CatalogInputSlot["dtype"][]>();
  const inputsByEntity = new Map<string, Set<string>>();
  for (const rule of rules) {
    const outerEntity = rule.entity ?? "Household";
    for (const { node, parent, scope } of walkRefs(rule.expr, null, outerEntity, relationEntityMap)) {
      if (node.kind !== "input") continue;
      const name = node.name as string;
      if (!dtypeCandidates.has(name)) dtypeCandidates.set(name, []);
      // An input that IS the rule body (no parent expression) inherits the
      // rule's declared dtype — e.g. `snap_total_allowable_shelter_expenses`
      // is a bare passthrough of a decimal input.
      if (parent === null) {
        const declared = rule.dtype;
        dtypeCandidates.get(name)!.push(
          declared === "integer" || declared === "decimal" || declared === "date" || declared === "text"
            ? declared
            : declared === "judgment"
              ? "bool"
              : "decimal"
        );
      } else {
        dtypeCandidates.get(name)!.push(inferDtype(parent, node, ruleDtypes));
      }
      if (!inputsByEntity.has(scope)) inputsByEntity.set(scope, new Set());
      inputsByEntity.get(scope)!.add(name);
    }
  }

  const periodStart = manifestProgram.period.length === 7
    ? `${manifestProgram.period}-01`
    : `${manifestProgram.period}-01-01`;

  // -- Decision-point mining --------------------------------------------------
  // The IR encodes several classes of "decision point" that defaults and the
  // LLM otherwise can't see. Mine them structurally for every program:
  //   1. enum-coded inputs — integer/text inputs used ONLY in equality
  //      comparisons against literals; each code labeled by the parameter or
  //      rule the matching branch selects;
  //   2. equality gates — non-bool inputs some rule compares against a
  //      literal the default doesn't satisfy (taxable_year_months == 12);
  //   3. variant switches — bool inputs whose if-branches select different
  //      rules/parameters (law-regime selectors, not household facts).
  const eqLiterals = new Map<string, Set<number | string>>();
  const nonEqUsage = new Set<string>();
  const enumLabels = new Map<string, Map<number | string, Map<string, number>>>();
  const variantSwitches = new Set<string>();

  const firstSelectorName = (node: unknown, depth = 0): string | null => {
    if (depth > 4 || node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = firstSelectorName(child, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    const n = node as IRNode;
    if (n.kind === "parameter_lookup" && typeof n.parameter === "string") return n.parameter;
    if (n.kind === "derived" && typeof n.name === "string") return n.name;
    for (const value of Object.values(n)) {
      const hit = firstSelectorName(value, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  const hasSelector = (node: unknown): boolean => firstSelectorName(node) !== null;

  const comparisonInputLiteral = (
    cmp: IRNode
  ): { input: string; literal: { kind: string; value: unknown } } | null => {
    if (cmp.kind !== "comparison") return null;
    for (const [a, b] of [["left", "right"], ["right", "left"]] as const) {
      const inputNode = cmp[a] as IRNode | undefined;
      const litNode = cmp[b] as IRNode | undefined;
      if (
        inputNode?.kind === "input" &&
        typeof inputNode.name === "string" &&
        litNode?.kind === "literal"
      ) {
        const inner = litNode.value as { kind: string; value: unknown };
        return { input: inputNode.name, literal: inner };
      }
    }
    return null;
  };

  const mineDecisionPoints = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(mineDecisionPoints); return; }
    if (node === null || typeof node !== "object") return;
    const n = node as IRNode;
    if (n.kind === "comparison") {
      const hit = comparisonInputLiteral(n);
      if (hit) {
        const op = n.op as string;
        if (op === "eq" || op === "ne") {
          if (hit.literal.kind === "integer" || hit.literal.kind === "text") {
            if (!eqLiterals.has(hit.input)) eqLiterals.set(hit.input, new Set());
            eqLiterals.get(hit.input)!.add(hit.literal.value as number | string);
          }
        } else {
          nonEqUsage.add(hit.input);
        }
      } else {
        // Comparison against non-literal — ordering/derived usage disqualifies
        // enum interpretation for any input operand.
        for (const side of ["left", "right"]) {
          const operand = n[side] as IRNode | undefined;
          if (operand?.kind === "input" && typeof operand.name === "string") {
            if ((n.op as string) !== "eq" && (n.op as string) !== "ne") nonEqUsage.add(operand.name);
          }
        }
      }
    }
    if (NUMERIC_PARENT_KINDS.has(n.kind as string)) {
      for (const value of Object.values(n)) {
        const visitOperand = (m: unknown) => {
          if (Array.isArray(m)) { m.forEach(visitOperand); return; }
          if (m && typeof m === "object" && (m as IRNode).kind === "input") {
            nonEqUsage.add((m as IRNode).name as string);
          }
        };
        visitOperand(value);
      }
    }
    if (n.kind === "if") {
      const condition = n.condition as IRNode | undefined;
      // Bare-input conditions (`if flag then … else …`) behave like `== true`.
      if (
        condition?.kind === "input" &&
        typeof condition.name === "string" &&
        hasSelector(n.then_expr) &&
        hasSelector(n.else_expr)
      ) {
        variantSwitches.add(condition.name as string);
      }
      const hit = condition ? comparisonInputLiteral(condition) : null;
      if (hit && (condition!.op === "eq")) {
        // Enum labels: which selector does this code's branch pick?
        if (hit.literal.kind === "integer" || hit.literal.kind === "text") {
          const label = firstSelectorName(n.then_expr);
          if (label) {
            if (!enumLabels.has(hit.input)) enumLabels.set(hit.input, new Map());
            const byValue = enumLabels.get(hit.input)!;
            const value = hit.literal.value as number | string;
            if (!byValue.has(value)) byValue.set(value, new Map());
            const counts = byValue.get(value)!;
            counts.set(label, (counts.get(label) ?? 0) + 1);
          }
        }
        // Variant switches: bool flag with substantive branches on both sides.
        if (hit.literal.kind === "bool" && hasSelector(n.then_expr) && hasSelector(n.else_expr)) {
          variantSwitches.add(hit.input);
        }
      }
    }
    for (const value of Object.values(n)) mineDecisionPoints(value);
  };
  for (const rule of rules) mineDecisionPoints(rule.expr);

  // -- Table-index default inference ----------------------------------------
  // Parameter tables are keyed 1..N (household size, day of month, …); an
  // input that feeds a lookup index but defaults to 0 makes the engine throw
  // "no value for key 0". Trace each lookup index back to the inputs it can
  // reach (through derived-rule chains) and default those to the table's
  // minimum key. Skipped when the index derives from a broad expression
  // (> 3 reachable inputs, e.g. income-banded tables) — bumping income
  // defaults would distort scenarios more than it fixes.
  const paramMinKey = new Map<string, number>();
  for (const param of (program as unknown as { parameters: Array<Record<string, unknown>> }).parameters) {
    const versions = param.versions as Array<{ values?: Record<string, unknown> }> | undefined;
    if (!versions) continue;
    let min = Infinity;
    for (const version of versions) {
      for (const key of Object.keys(version.values ?? {})) {
        const n = Number(key);
        if (Number.isFinite(n)) min = Math.min(min, n);
      }
    }
    if (Number.isFinite(min)) paramMinKey.set(param.name as string, min);
  }

  const ruleDirectInputs = new Map<string, Set<string>>();
  const ruleDirectDerived = new Map<string, Set<string>>();
  const collectDirect = (name: string, expr: unknown) => {
    const inputsSet = new Set<string>();
    const derivedSet = new Set<string>();
    const visit = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (n === null || typeof n !== "object") return;
      const obj = n as IRNode;
      if (obj.kind === "input" && typeof obj.name === "string") inputsSet.add(obj.name);
      if (obj.kind === "derived" && typeof obj.name === "string") derivedSet.add(obj.name);
      Object.values(obj).forEach(visit);
    };
    visit(expr);
    ruleDirectInputs.set(name, inputsSet);
    ruleDirectDerived.set(name, derivedSet);
  };
  for (const rule of rules) collectDirect(rule.name, rule.expr);

  const reachableMemo = new Map<string, Set<string>>();
  const reachableInputs = (ruleName: string, seen = new Set<string>()): Set<string> => {
    const memo = reachableMemo.get(ruleName);
    if (memo) return memo;
    if (seen.has(ruleName)) return new Set();
    seen.add(ruleName);
    const result = new Set(ruleDirectInputs.get(ruleName) ?? []);
    for (const dep of ruleDirectDerived.get(ruleName) ?? []) {
      for (const input of reachableInputs(dep, seen)) result.add(input);
    }
    reachableMemo.set(ruleName, result);
    return result;
  };

  // -- Evaluation period ------------------------------------------------------
  // Some programs certify a period before every parameter table takes effect
  // (e.g. an FPL table effective 2026-03 in a program certified 2026-01).
  // Derive the earliest month where every parameter reachable from the
  // certified outputs has a covering version, and surface it as the default
  // evaluation period.
  const ruleDirectParams = new Map<string, Set<string>>();
  for (const rule of rules) {
    const params = new Set<string>();
    const visit = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (n === null || typeof n !== "object") return;
      const obj = n as IRNode;
      if (obj.kind === "parameter_lookup" && typeof obj.parameter === "string") params.add(obj.parameter);
      Object.values(obj).forEach(visit);
    };
    visit(rule.expr);
    ruleDirectParams.set(rule.name, params);
  }
  const paramVersions = new Map<string, Array<{ effective_from?: string; effective_to?: string }>>();
  for (const param of (program as unknown as { parameters: Array<Record<string, unknown>> }).parameters) {
    const versions = param.versions as Array<{ effective_from?: string; effective_to?: string }> | undefined;
    if (versions) paramVersions.set(param.name as string, versions);
  }
  const reachableParamsMemo = new Map<string, Set<string>>();
  const reachableParams = (ruleName: string, seen = new Set<string>()): Set<string> => {
    const memo = reachableParamsMemo.get(ruleName);
    if (memo) return memo;
    if (seen.has(ruleName)) return new Set();
    seen.add(ruleName);
    const result = new Set(ruleDirectParams.get(ruleName) ?? []);
    for (const dep of ruleDirectDerived.get(ruleName) ?? []) {
      for (const param of reachableParams(dep, seen)) result.add(param);
    }
    reachableParamsMemo.set(ruleName, result);
    return result;
  };
  let evaluationStart = periodStart;
  {
    const certifiedParams = new Set<string>();
    for (const output of manifestProgram.outputs) {
      for (const param of reachableParams(output)) certifiedParams.add(param);
    }
    for (const param of certifiedParams) {
      const versions = paramVersions.get(param);
      if (!versions || versions.length === 0) continue;
      const covered = versions.some(
        (v) =>
          (!v.effective_from || v.effective_from <= evaluationStart) &&
          (!v.effective_to || v.effective_to > evaluationStart)
      );
      if (!covered) {
        const earliest = versions
          .map((v) => v.effective_from)
          .filter((d): d is string => !!d)
          .sort()[0];
        if (earliest && earliest > evaluationStart) evaluationStart = earliest;
      }
    }
  }
  const evaluationPeriod =
    manifestProgram.period.length === 7 ? evaluationStart.slice(0, 7) : evaluationStart.slice(0, 4);
  if (evaluationPeriod !== manifestProgram.period) {
    warn(
      `certified period ${manifestProgram.period} predates parameter coverage; defaulting evaluation to ${evaluationPeriod}`
    );
  }

  const minKeyDefaults = new Map<string, number>();
  const visitLookups = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(visitLookups); return; }
    if (n === null || typeof n !== "object") return;
    const obj = n as IRNode;
    if (obj.kind === "parameter_lookup" && typeof obj.parameter === "string") {
      const minKey = paramMinKey.get(obj.parameter);
      if (minKey !== undefined && minKey > 0) {
        const indexInputs = new Set<string>();
        const visitIndex = (m: unknown) => {
          if (Array.isArray(m)) { m.forEach(visitIndex); return; }
          if (m === null || typeof m !== "object") return;
          const inner = m as IRNode;
          if (inner.kind === "input" && typeof inner.name === "string") indexInputs.add(inner.name);
          if (inner.kind === "derived" && typeof inner.name === "string") {
            for (const input of reachableInputs(inner.name)) indexInputs.add(input);
          }
          Object.values(inner).forEach(visitIndex);
        };
        visitIndex(obj.index);
        if (indexInputs.size > 0 && indexInputs.size <= 3) {
          for (const input of indexInputs) {
            minKeyDefaults.set(input, Math.max(minKeyDefaults.get(input) ?? 0, minKey));
          }
        }
      }
    }
    Object.values(obj).forEach(visitLookups);
  };
  for (const rule of rules) visitLookups(rule.expr);

  const mined = new Map<string, { dtype: CatalogInputSlot["dtype"]; default: boolean | number | string }>();
  for (const fixture of fixtureCandidates) {
    try {
      for (const [name, value] of mineFixture(fixture)) {
        if (!mined.has(name)) mined.set(name, value);
      }
    } catch (err) {
      warn(`fixture mining failed for ${fixture}: ${(err as Error).message}`);
    }
  }

  // Household money-quantity slots (income, expenses, costs) whose
  // fixture-mined values would silently bake a specific scenario into every
  // computation (e.g. AZ's fixture earns $1,003/mo). Parameter-like inputs
  // (allowances, allotments, standards, plans, limits) keep fixture values —
  // those ARE reference data, not scenario facts.
  // Inputs reachable from the certified outputs — everything else is an
  // auxiliary chain whose slots cannot move the headline numbers.
  const certifiedPathInputs = new Set<string>();
  for (const outputName of manifestProgram.outputs) {
    for (const input of reachableInputs(outputName)) certifiedPathInputs.add(input);
  }

  const SCENARIO_QUANTITY =
    /(earned|unearned|gross|countable)_.*income|_income$|income_received|wages|earnings|_expenses?$|_expenses?_|_costs?$|costs?_incurred|payments?_(received|for)|_payments$/;
  const PARAMETER_LIKE =
    /allowance|allotment|standard|minimum|maximum|plan|limit|threshold|rate$/;
  const suppressedFixtureDefaults: string[] = [];

  const slotFor = (name: string): CatalogInputSlot => {
    const slot: CatalogInputSlot = { name, dtype: "bool", default: false };

    const candidates = dtypeCandidates.get(name) ?? [];
    const inferredDtype = candidates.length
      ? candidates.reduce((best, c) => ((DTYPE_RANK[c] ?? 0) > (DTYPE_RANK[best] ?? 0) ? c : best))
      : "bool";

    const fromFixture = mined.get(name);
    if (fromFixture) {
      slot.dtype = fromFixture.dtype;
      const isQuantity =
        (fromFixture.dtype === "integer" || fromFixture.dtype === "decimal") &&
        typeof fromFixture.default === "number" &&
        fromFixture.default !== 0 &&
        SCENARIO_QUANTITY.test(name) &&
        !PARAMETER_LIKE.test(name);
      if (isQuantity) {
        suppressedFixtureDefaults.push(`${name}=${fromFixture.default}`);
        slot.default = 0;
      } else {
        slot.default = fromFixture.default;
        slot.default_source = "fixture";
      }
    } else {
      slot.dtype = inferredDtype;
      const minKey = minKeyDefaults.get(name);
      if ((inferredDtype === "integer" || inferredDtype === "decimal") && minKey !== undefined) {
        slot.default = minKey;
        slot.default_source = "table_min";
      } else {
        slot.default = defaultFor(inferredDtype, periodStart);
      }
    }

    // Overlay defaults win over everything — curated law-variant/administrative
    // facts, disclosed via default_source. Global entries apply to any program
    // carrying the slot; per-program entries win over global.
    const override = overlay.default_overrides?.[name] ?? GLOBAL_DEFAULT_OVERRIDES[name];
    if (override !== undefined) {
      slot.default = override;
      slot.default_source = "overlay";
      if (GLOBAL_DEFAULT_OVERRIDES[name] !== undefined) matchedGlobalOverrides.add(name);
    }

    // Decision-point annotations.
    if (
      (slot.dtype === "integer" || slot.dtype === "text") &&
      !nonEqUsage.has(name) &&
      (eqLiterals.get(name)?.size ?? 0) >= 2
    ) {
      const labels = enumLabels.get(name);
      const entries: Record<string, string> = {};
      for (const value of [...eqLiterals.get(name)!].sort()) {
        const counts = labels?.get(value);
        const best = counts ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
        entries[String(value)] = best ?? "";
      }
      slot.enum = entries;
    } else if (slot.dtype !== "bool") {
      const unsatisfied = [...(eqLiterals.get(name) ?? [])].filter((v) => v !== slot.default);
      if (unsatisfied.length > 0 && unsatisfied.length <= 4) {
        slot.eq_hints = unsatisfied.sort();
      }
    }
    if (slot.dtype === "bool" && variantSwitches.has(name)) {
      slot.variant_switch = true;
    }
    if (certifiedPathInputs.size > 0 && !certifiedPathInputs.has(name)) {
      slot.aux = true;
    }
    return slot;
  };

  const inputs: Record<string, CatalogInputSlot[]> = {};
  for (const [entity, names] of [...inputsByEntity.entries()].sort()) {
    inputs[entity] = [...names].sort().map(slotFor);
  }
  if (suppressedFixtureDefaults.length) {
    warn(`fixture scenario-quantity defaults suppressed to 0: ${suppressedFixtureDefaults.join(", ")}`);
  }
  for (const name of Object.keys(overlay.default_overrides ?? {})) {
    if (![...slotsSeen(inputs)].includes(name)) {
      warn(`overlay default_overrides names unknown slot: ${name}`);
    }
  }
  function* slotsSeen(byEntity: Record<string, CatalogInputSlot[]>) {
    for (const slots of Object.values(byEntity)) for (const s of slots) yield s.name;
  }

  // -- Judgment requirements mining ------------------------------------------
  // For each judgment rule, collect the input facts in its *unconditional
  // conjunction chain* (descending `and` nodes and derived refs, but never
  // `or`/`not`/`if` — those are disjunctive or conditional). These are the
  // facts that must hold for the judgment to hold, i.e. exactly what the LLM
  // must set to make a member qualify.
  const REQUIRES_DEPTH = 5;
  const REQUIRES_CAP = 12;
  const requiresMemo = new Map<string, { reqs: Map<string, boolean | number | string>; partial: boolean }>();
  const conjunctiveRequirements = (
    ruleName: string,
    seen = new Set<string>()
  ): { reqs: Map<string, boolean | number | string>; partial: boolean } => {
    const memo = requiresMemo.get(ruleName);
    if (memo) return memo;
    if (seen.has(ruleName) || seen.size > REQUIRES_DEPTH) return { reqs: new Map(), partial: true };
    const rule = ruleByName.get(ruleName);
    if (!rule) return { reqs: new Map(), partial: true };
    seen.add(ruleName);
    const reqs = new Map<string, boolean | number | string>();
    let partial = false;
    const visit = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (n === null || typeof n !== "object") return;
      const node = n as IRNode;
      if (node.kind === "and") {
        for (const value of Object.values(node)) visit(value);
        return;
      }
      if (node.kind === "comparison" && node.op === "eq") {
        const hit = comparisonInputLiteral(node);
        if (hit && (hit.literal.kind === "bool" || hit.literal.kind === "integer" || hit.literal.kind === "text")) {
          reqs.set(hit.input, hit.literal.value as boolean | number | string);
          return;
        }
        partial = true;
        return;
      }
      if (node.kind === "derived" && typeof node.name === "string") {
        const sub = conjunctiveRequirements(node.name, new Set(seen));
        for (const [slot, value] of sub.reqs) reqs.set(slot, value);
        if (sub.partial) partial = true;
        return;
      }
      // Anything else (or/not/if/aggregators/arithmetic) is not an
      // unconditional requirement — mark and stop descending.
      if (node.kind) partial = true;
    };
    visit(rule.expr);
    const result = { reqs, partial };
    requiresMemo.set(ruleName, result);
    return result;
  };

  // -- Outputs ---------------------------------------------------------------
  const outputs: CatalogOutput[] = rules.map((rule) => {
    const output: CatalogOutput = {
      name: rule.name,
      id: rule.id ?? null,
      entity: rule.entity ?? "Household",
      semantics: rule.semantics ?? "scalar",
      dtype: rule.dtype ?? null,
      unit: rule.unit ?? null,
      period: rule.period ?? null,
      source: rule.source ?? null,
      certified: certified.has(rule.name),
      acknowledged_incomplete: acknowledgedIncomplete.includes(rule.name),
    };
    if ((rule.semantics ?? "scalar") === "judgment") {
      const { reqs, partial } = conjunctiveRequirements(rule.name);
      if (reqs.size > 0 && reqs.size <= REQUIRES_CAP) {
        output.requires = [...reqs.entries()].map(([slot, value]) => ({ slot, value }));
        if (partial) output.requires_partial = true;
      }
    }
    return output;
  });

  const entities = [...new Set([
    ...entityFrequency.keys(),
    ...Object.keys(inputs),
  ])].sort();

  return {
    slug,
    jurisdiction: manifestProgram.jurisdiction,
    program_id: manifestProgram.program_id,
    period: manifestProgram.period,
    evaluation_period: evaluationPeriod,
    display_name: overlay.display_name ?? programDisplayName(manifestProgram.jurisdiction, manifestProgram.program_id),
    description: overlay.description ?? program.module?.summary ?? "",
    spec_path: manifestProgram.spec_path,
    primary_entity: primaryEntity,
    member_entity: memberEntity,
    entities,
    relations,
    certified_outputs: certifiedList,
    acknowledged_incomplete: acknowledgedIncomplete,
    primary_output: primaryOutput,
    outputs,
    inputs,
    counts: manifestProgram.counts,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const lock = JSON.parse(readFileSync(path.join(ROOT, "artifacts.lock.json"), "utf8")) as {
    repo: string;
    release_tag: string;
    corpus_sha: string;
  };
  const manifest = JSON.parse(
    readFileSync(path.join(ARTIFACTS_DIR, "manifest.json"), "utf8")
  ) as { corpus: { sha: string }; programs: ManifestProgram[] };
  if (manifest.corpus.sha !== lock.corpus_sha) {
    throw new Error("manifest/lock corpus sha mismatch — run `bun run artifacts:fetch` first");
  }

  const corpusDir = ensureCorpusCheckout(lock);
  const warnings: string[] = [];

  console.log(`==> generating catalog for ${manifest.programs.length} programs`);
  const programs = manifest.programs
    .map((mp) => analyzeProgram(mp, corpusDir, warnings))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // A global default whose slot no longer exists anywhere is a silent no-op
  // waiting to reintroduce a fail-closed bug (an artifact bump can rename a
  // slot out from under the overlay). Surface it as a warning every run.
  for (const key of Object.keys(GLOBAL_DEFAULT_OVERRIDES)) {
    if (!matchedGlobalOverrides.has(key)) {
      warnings.push(`GLOBAL_DEFAULT_OVERRIDES["${key}"] matched no slot in any program — renamed or removed by the artifact pin?`);
    }
  }

  const corpusPaths = collectCorpusPaths(corpusDir);

  const catalog = {
    release_tag: lock.release_tag,
    corpus_sha: lock.corpus_sha,
    repo: lock.repo,
    programs,
    corpus_paths: corpusPaths,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(catalog, null, 1) + "\n");

  // -- Coverage report -------------------------------------------------------
  console.log("\nslug                    entity        outputs certified incomplete inputs(entity:count)         relations");
  for (const p of programs) {
    const inputSummary = Object.entries(p.inputs)
      .map(([entity, slots]) => `${entity}:${slots.length}`)
      .join(" ");
    const relationSummary = p.relations
      .filter((r) => r.used)
      .map((r) => `${r.name.split("#").pop()?.replace("relation.", "")}→${r.related_entity ?? "?"}`)
      .join(" ");
    console.log(
      `${p.slug.padEnd(24)}${p.primary_entity.padEnd(14)}${String(p.outputs.length).padEnd(8)}${String(p.certified_outputs.length).padEnd(10)}${String(p.acknowledged_incomplete.length).padEnd(11)}${inputSummary.padEnd(29)}${relationSummary}`
    );
  }
  console.log("\ndecision points (enum-coded / eq-gated / variant-switch / overlay-defaulted slots):");
  for (const p of programs) {
    const slots = Object.values(p.inputs).flat();
    const enums = slots.filter((s) => s.enum);
    const eqGated = slots.filter((s) => s.eq_hints);
    const variants = slots.filter((s) => s.variant_switch);
    const overlaid = slots.filter((s) => s.default_source === "overlay");
    if (enums.length || eqGated.length || variants.length || overlaid.length) {
      console.log(
        `  ${p.slug.padEnd(20)} enum:[${enums.map((s) => s.name).join(", ")}] eq:[${eqGated
          .map((s) => `${s.name}=${s.eq_hints!.join("|")}`)
          .join(", ")}] variant:[${variants.map((s) => s.name).slice(0, 6).join(", ")}${variants.length > 6 ? ` +${variants.length - 6}` : ""}] overlay:[${overlaid.map((s) => s.name).join(", ")}]`
      );
    }
  }

  console.log(`\ncorpus citation paths: ${Object.keys(corpusPaths).length}`);
  if (warnings.length) {
    console.log(`\nwarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
  } else {
    console.log("\nno warnings");
  }
  const bytes = (await fs.stat(OUTPUT_PATH)).size;
  console.log(`\nwrote ${path.relative(ROOT, OUTPUT_PATH)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
