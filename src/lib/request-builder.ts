/**
 * Generic engine-request builder — works for every program in the catalog.
 *
 * Replaces the per-program adapters that used to live in src/lib/programs/.
 * Everything here is driven by the generated catalog (entities, relations,
 * input slots with dtypes and defaults, output metadata):
 *
 *   - every input slot the program reaches gets an InputRecord (default value
 *     unless overridden by user facts), so the engine always sees a fully
 *     specified scenario;
 *   - the member entity (e.g. Person) gets one instance per household member,
 *     linked to the primary entity through the recorded relation tuples;
 *   - queries route each output to the instance matching its entity and are
 *     grouped by the rule's period grain (Month vs Year);
 *   - unknown fact names produce a structured error with nearest-match
 *     suggestions so the LLM can self-correct.
 */
import {
  type ExecutionRequest,
  type ExecutionResponse,
  type FactScalar,
  type InputRecord,
  type Interval,
  type QueryRequest,
  type RelationRecord,
  fact,
  monthInterval,
  readOutput,
  runCompiled,
  yearInterval,
} from "./engine";
import type { CatalogInputSlot, CatalogOutput, CatalogProgram } from "./catalog";
import { legalIdToUrl } from "./legal-links";

export type Facts = Record<string, FactScalar>;

export interface MemberSpec {
  facts?: Facts;
  /** Relation names (full or short, e.g. "dependent_of_tax_unit") linking
   *  this member to the primary entity. Defaults to every member relation. */
  relations?: string[];
}

export interface BuildOptions {
  program: CatalogProgram;
  /** "YYYY-MM" or "YYYY"; defaults to the program's certified period. */
  period?: string;
  facts?: Facts;
  members?: MemberSpec[];
  /** Extra output names (or legal ids) to query beyond the certified set. */
  extraOutputs?: string[];
  /** Query exactly these outputs instead of primary + certified (lookup path). */
  outputsOverride?: string[];
  mode?: "fast" | "explain";
}

export class UnknownInputError extends Error {
  readonly kind = "unknown_input";
  constructor(
    readonly slot: string,
    readonly suggestions: string[],
    programSlug: string
  ) {
    super(
      `unknown input "${slot}" for ${programSlug}` +
        (suggestions.length ? `; closest slots: ${suggestions.join(", ")}` : "")
    );
  }
}

export class UnknownOutputError extends Error {
  readonly kind = "unknown_output";
  constructor(
    readonly output: string,
    readonly suggestions: string[],
    programSlug: string
  ) {
    super(
      `unknown output "${output}" for ${programSlug}` +
        (suggestions.length ? `; closest outputs: ${suggestions.join(", ")}` : "")
    );
  }
}

/** Token-overlap nearest-match scoring for self-correcting error messages. */
export function nearestNames(needle: string, haystack: Iterable<string>, limit = 5): string[] {
  const tokens = new Set(needle.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of haystack) {
    const candidateTokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    for (const token of candidateTokens) {
      if (tokens.has(token)) score += 2;
      else if ([...tokens].some((t) => token.includes(t) || t.includes(token))) score += 1;
    }
    if (score > 0) scored.push({ name, score: score / Math.sqrt(candidateTokens.length) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.name);
}

function instanceId(entity: string, index = 1): string {
  return `${entity.toLowerCase()}:${index}`;
}

// The engine resolves inputs by their `input.<NAME>` fragment; the prefix is
// only display. Use a synthetic per-program prefix (matches the old CO setup).
function legalInputId(slug: string, slot: string): string {
  return `axiom:${slug}#input.${slot}`;
}

interface ResolvedPeriod {
  month: { interval: Interval; period: QueryRequest["period"] };
  year: { interval: Interval; period: QueryRequest["period"] };
  label: string;
}

/** Default evaluation period when the user doesn't specify one: the current
 *  month (current year for annual programs), never earlier than the program's
 *  parameter-coverage floor. The certified period in the manifest is when the
 *  release was cut, not when users are asking. */
export function defaultPeriodFor(program: CatalogProgram, now = new Date()): string {
  const annual = /^\d{4}$/.test(program.period);
  const current = annual
    ? String(now.getFullYear())
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const floor = program.evaluation_period || program.period;
  // ISO-shaped strings compare lexicographically.
  return current >= floor ? current : floor;
}

function resolvePeriod(program: CatalogProgram, requested?: string): ResolvedPeriod {
  const raw = requested?.trim() || defaultPeriodFor(program);
  let month: string;
  let year: number;
  if (/^\d{4}-\d{2}$/.test(raw)) {
    month = raw;
    year = Number(raw.slice(0, 4));
  } else if (/^\d{4}$/.test(raw)) {
    year = Number(raw);
    // Fall back to the program's certified month when it has one, else January.
    month = /^\d{4}-\d{2}$/.test(program.period)
      ? `${raw}-${program.period.slice(5, 7)}`
      : `${raw}-01`;
  } else {
    throw new Error(`invalid period "${raw}" — use YYYY-MM or YYYY`);
  }
  return { month: monthInterval(month), year: yearInterval(year), label: raw };
}

function periodForOutput(output: CatalogOutput, resolved: ResolvedPeriod, program: CatalogProgram) {
  if (output.period === "Year") return resolved.year;
  if (output.period === "Month") return resolved.month;
  // Week/Day/unspecified rules: fall back to the program's certified grain.
  return /^\d{4}$/.test(program.period) ? resolved.year : resolved.month;
}

/** Resolve an output reference (bare name or legal id) to catalog metadata. */
export function resolveOutput(program: CatalogProgram, ref: string): CatalogOutput {
  const found = program.outputs.find((o) => o.name === ref || o.id === ref);
  if (found) return found;
  throw new UnknownOutputError(
    ref,
    nearestNames(ref, program.outputs.map((o) => o.name)),
    program.slug
  );
}

/** Query key the engine resolves: legal id when the rule has one, else name. */
export function queryKey(output: CatalogOutput): string {
  return output.id ?? output.name;
}

export interface BuiltRequest {
  request: ExecutionRequest;
  queried: CatalogOutput[];
  /** Member-gate judgments auto-queried at the first member instance. */
  memberCheckNames: Set<string>;
  applied: {
    period: string;
    member_count: number;
    facts_applied: Facts;
    defaulted_slots: number;
    notes: string[];
  };
}

const SIZE_SLOT = /(household|family|unit)_size$/;

export function buildRequest(options: BuildOptions): BuiltRequest {
  const { program } = options;
  const facts = { ...(options.facts ?? {}) };
  const notes: string[] = [];
  const resolved = resolvePeriod(program, options.period);

  // -- Validate fact names against the slot universe -------------------------
  const slotsByName = new Map<string, CatalogInputSlot>();
  const slotEntities = new Map<string, string[]>();
  for (const [entity, slots] of Object.entries(program.inputs)) {
    for (const slot of slots) {
      if (!slotsByName.has(slot.name)) slotsByName.set(slot.name, slot);
      if (!slotEntities.has(slot.name)) slotEntities.set(slot.name, []);
      slotEntities.get(slot.name)!.push(entity);
    }
  }
  // Suggestions rank on-path slots first — auxiliary slots are usually the
  // trap, not the fix.
  const suggestSlots = (needle: string): string[] => {
    const slots = [...slotsByName.values()];
    const onPath = nearestNames(needle, slots.filter((s) => !s.aux).map((s) => s.name), 5);
    const aux = nearestNames(needle, slots.filter((s) => s.aux).map((s) => s.name), 2);
    return [...onPath, ...aux.filter((n) => !onPath.includes(n))].slice(0, 5);
  };
  for (const name of Object.keys(facts)) {
    if (!slotsByName.has(name)) {
      throw new UnknownInputError(name, suggestSlots(name), program.slug);
    }
  }
  for (const member of options.members ?? []) {
    for (const name of Object.keys(member.facts ?? {})) {
      if (!slotsByName.has(name)) {
        throw new UnknownInputError(name, suggestSlots(name), program.slug);
      }
    }
  }

  // Facts landing on auxiliary slots (not reachable from any certified
  // output) silently do nothing to the headline — the classic trap is a
  // plausible sibling name (`countable_monthly_unearned_income` vs the live
  // `snap_total_monthly_unearned_income`). Surface it loudly in the applied
  // report with the nearest on-path sibling.
  const certifiedSlotNames = [...slotsByName.values()].filter((s) => !s.aux).map((s) => s.name);
  for (const name of Object.keys(facts)) {
    if (slotsByName.get(name)?.aux) {
      const siblings = nearestNames(name, certifiedSlotNames, 3);
      notes.push(
        `WARNING: fact "${name}" targets an auxiliary slot that does NOT feed the certified outputs — the headline ignores it.` +
          (siblings.length ? ` Did you mean: ${siblings.join(", ")}?` : "")
      );
    }
  }

  // -- Member count ----------------------------------------------------------
  const memberEntity = program.member_entity;
  let memberCount = 0;
  if (memberEntity) {
    if (options.members?.length) {
      memberCount = options.members.length;
    } else {
      const sizeFact = Object.entries(facts).find(
        ([name, value]) => SIZE_SLOT.test(name) && typeof value === "number" && value >= 1
      );
      memberCount = sizeFact ? Math.min(20, Math.floor(sizeFact[1] as number)) : 1;
      if (sizeFact) notes.push(`synthesized ${memberCount} ${memberEntity} member(s) from ${sizeFact[0]}`);
    }
    // Keep size-style inputs consistent with an explicit members list.
    if (options.members?.length) {
      for (const name of slotsByName.keys()) {
        if (SIZE_SLOT.test(name) && facts[name] === undefined) {
          facts[name] = memberCount;
          notes.push(`set ${name}=${memberCount} to match members[]`);
        }
      }
    }
  }

  // -- Resolve queried outputs ----------------------------------------------
  const queried: CatalogOutput[] = [];
  const seen = new Set<string>();
  const addOutput = (o: CatalogOutput) => {
    if (!seen.has(o.name)) {
      seen.add(o.name);
      queried.push(o);
    }
  };
  if (options.outputsOverride) {
    for (const ref of options.outputsOverride) addOutput(resolveOutput(program, ref));
  } else {
    addOutput(resolveOutput(program, program.primary_output));
    for (const name of program.certified_outputs) addOutput(resolveOutput(program, name));
  }
  for (const ref of options.extraOutputs ?? []) addOutput(resolveOutput(program, ref));

  // Member checks: the judgments that gate whether a member counts inside
  // relation aggregators (e.g. ctc_qualifying_child, snap_member_eligible).
  // Auto-queried at the first member instance so a compute with members shows
  // WHY a member did or didn't count — with `requires` attached on failure.
  const memberCheckNames = new Set<string>();
  if (memberEntity && memberCount > 0 && !options.outputsOverride) {
    for (const relation of program.relations) {
      if (relation.related_entity !== memberEntity) continue;
      for (const gate of relation.gate_judgments ?? []) {
        const output = program.outputs.find((o) => o.name === gate);
        if (output && output.entity === memberEntity && !seen.has(output.name)) {
          memberCheckNames.add(output.name);
          addOutput(output);
        }
      }
    }
  }

  // -- Instances -------------------------------------------------------------
  const primaryId = instanceId(program.primary_entity);
  // Non-member instances that receive queries get the full union of
  // non-member-scope inputs — the engine evaluates every rule it reaches at
  // the queried entity id and does not enforce entity identity, so the union
  // is what makes cross-entity rule chains resolvable.
  const queryInstances = new Map<string, string>(); // entity → entity_id
  queryInstances.set(program.primary_entity, primaryId);
  for (const output of queried) {
    if (output.entity === memberEntity) continue;
    if (!queryInstances.has(output.entity)) {
      queryInstances.set(output.entity, instanceId(output.entity));
    }
  }

  // -- Input records ---------------------------------------------------------
  const spanStart = queried.some((o) => periodForOutput(o, resolved, program) === resolved.year)
    ? resolved.year.interval.start
    : resolved.month.interval.start;
  const spanEnd = queried.some((o) => periodForOutput(o, resolved, program) === resolved.year)
    ? resolved.year.interval.end
    : resolved.month.interval.end;
  const inputInterval: Interval = {
    start: spanStart < resolved.month.interval.start ? spanStart : resolved.month.interval.start,
    end: spanEnd > resolved.month.interval.end ? spanEnd : resolved.month.interval.end,
  };

  const inputs: InputRecord[] = [];
  let defaultedSlots = 0;

  const record = (slot: CatalogInputSlot, entity: string, entityId: string, override?: FactScalar) => {
    const value = override !== undefined ? override : slot.default;
    if (override === undefined) defaultedSlots++;
    inputs.push({
      name: legalInputId(program.slug, slot.name),
      entity,
      entity_id: entityId,
      interval: inputInterval,
      value: fact(value as FactScalar, slot.dtype),
    });
  };

  // Union of non-member-scope slots for query instances.
  const nonMemberSlots = new Map<string, CatalogInputSlot>();
  for (const [entity, slots] of Object.entries(program.inputs)) {
    if (entity === memberEntity) continue;
    for (const slot of slots) {
      if (!nonMemberSlots.has(slot.name)) nonMemberSlots.set(slot.name, slot);
    }
  }
  for (const [entity, entityId] of queryInstances) {
    for (const slot of nonMemberSlots.values()) {
      record(slot, entity, entityId, facts[slot.name]);
    }
  }

  // Member instances get member-scope slots; member 1 also absorbs top-level
  // facts that name member-scope slots (so "member_age: 34" works without an
  // explicit members list).
  const relations: RelationRecord[] = [];
  if (memberEntity && memberCount > 0) {
    const memberSlots = program.inputs[memberEntity] ?? [];
    const memberRelations = program.relations.filter(
      (r) => r.related_entity === memberEntity && (r.used || program.relations.length === 1)
    );
    const shortName = (name: string) => name.split("#").pop()!.replace(/^relation\./, "");

    // Top-level facts that name member-scope slots: with an explicit
    // members[] they form the shared base for EVERY member (taxpayer-level
    // facts like SSN-on-return are member-scoped in the IR but identical
    // across members); with synthesized members they go to member 1 only
    // (primary-applicant semantics, e.g. oldest_member_age).
    const explicitMembers = (options.members?.length ?? 0) > 0;
    for (let i = 0; i < memberCount; i++) {
      const memberId = instanceId(memberEntity, i + 1);
      const spec = options.members?.[i];
      const base = explicitMembers || i === 0 ? topLevelMemberFacts() : {};
      const memberFacts: Facts = { ...base, ...(spec?.facts ?? {}) };
      for (const slot of memberSlots) {
        record(slot, memberEntity, memberId, memberFacts[slot.name]);
      }
      const wanted = spec?.relations;
      for (const relation of memberRelations) {
        if (
          wanted &&
          !wanted.includes(relation.name) &&
          !wanted.includes(shortName(relation.name))
        ) {
          continue;
        }
        const tuple: [string, string] = relation.member_slot === 0
          ? [memberId, primaryId]
          : [primaryId, memberId];
        relations.push({ name: relation.name, tuple, interval: inputInterval });
      }
    }

    function topLevelMemberFacts(): Facts {
      const out: Facts = {};
      const memberSlotNames = new Set(memberSlots.map((s) => s.name));
      for (const [name, value] of Object.entries(facts)) {
        // Only divert facts that are exclusively member-scoped; shared-scope
        // facts already landed on the non-member instances above.
        if (memberSlotNames.has(name)) out[name] = value;
      }
      return out;
    }

    // Member-check queries evaluate member-entity judgments at member 1; any
    // household-scope inputs those rule chains read must resolve there too.
    // Add the non-member union to member 1, excluding slots that already have
    // member-scope records (duplicates with conflicting values would be
    // ambiguous).
    if (memberCheckNames.size > 0) {
      const memberSlotNames = new Set(memberSlots.map((s) => s.name));
      const member1 = instanceId(memberEntity, 1);
      for (const slot of nonMemberSlots.values()) {
        if (memberSlotNames.has(slot.name)) continue;
        record(slot, memberEntity, member1, facts[slot.name]);
      }
    }
  }

  // -- Queries grouped by (entity_id, period) --------------------------------
  const queryGroups = new Map<string, QueryRequest>();
  for (const output of queried) {
    const { period } = periodForOutput(output, resolved, program);
    const entityId =
      output.entity === memberEntity && memberEntity
        ? instanceId(memberEntity, 1)
        : queryInstances.get(output.entity) ?? primaryId;
    const key = `${entityId}|${period.period_kind}|${period.start}`;
    if (!queryGroups.has(key)) {
      queryGroups.set(key, { entity_id: entityId, period, outputs: [] });
    }
    queryGroups.get(key)!.outputs.push(queryKey(output));
  }

  // Member-scope inputs for member queries: if a queried output lives on the
  // member entity, the first member instance already has its slots.

  return {
    request: {
      mode: options.mode ?? "explain",
      dataset: { inputs, relations },
      queries: [...queryGroups.values()],
    },
    queried,
    memberCheckNames,
    applied: {
      period: resolved.label,
      member_count: memberCount,
      facts_applied: facts,
      defaulted_slots: defaultedSlots,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

export interface ShapedOutput {
  name: string;
  label: string;
  value: number | boolean | string | "holds" | "not_holds" | null;
  unit: string | null;
  semantics: string;
  entity: string;
  certified: boolean;
  acknowledged_incomplete: boolean;
  legal_id: string | null;
  /** Attached when a judgment came back not_holds: the facts (with values)
   *  its unconditional conjunction chain requires — what to set to make it
   *  hold. `requires_partial` marks additional conditional/disjunctive logic
   *  not captured here. */
  requires?: Array<{ slot: string; value: boolean | number | string }>;
  requires_partial?: boolean;
}

export interface ShapedResult {
  program: string;
  display_name: string;
  period: string;
  member_count: number;
  primary_output: string;
  outputs: ShapedOutput[];
  /** Judgments gating whether member 1 counts inside relation aggregators,
   *  with `requires` (the facts to set) attached on failure. */
  member_checks?: ShapedOutput[];
  applied: BuiltRequest["applied"];
  citations: Array<{ id: string; url: string }>;
  incomplete_note: string | null;
}

export function labelFor(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function shapeResult(
  program: CatalogProgram,
  built: BuiltRequest,
  response: ExecutionResponse
): ShapedResult {
  const merged = new Map<string, ReturnType<typeof readOutput> & { raw?: unknown }>();
  for (const result of response.results) {
    for (const [key, value] of Object.entries(result.outputs ?? {})) {
      merged.set(key, readOutput(value));
    }
  }

  const shaped: ShapedOutput[] = built.queried.map((output) => {
    const r = merged.get(queryKey(output));
    let value: ShapedOutput["value"] = null;
    if (r) value = r.kind === "judgment" ? r.outcome ?? null : r.numeric ?? null;
    const failedJudgment = output.semantics === "judgment" && value === "not_holds";
    return {
      name: output.name,
      label: labelFor(output.name),
      value,
      unit: output.unit,
      semantics: output.semantics,
      entity: output.entity,
      certified: output.certified,
      acknowledged_incomplete: output.acknowledged_incomplete,
      legal_id: output.id,
      ...(failedJudgment && output.requires && {
        requires: output.requires,
        ...(output.requires_partial && { requires_partial: true }),
      }),
    };
  });

  const memberChecks = shaped.filter((o) => built.memberCheckNames.has(o.name));
  const mainOutputs = shaped.filter((o) => !built.memberCheckNames.has(o.name));

  // Primary first, then judgments, then remaining scalars.
  mainOutputs.sort((a, b) => {
    const rank = (o: ShapedOutput) =>
      o.name === program.primary_output ? 0 : o.semantics === "judgment" ? 1 : 2;
    return rank(a) - rank(b);
  });

  const incomplete = mainOutputs.filter((o) => o.acknowledged_incomplete).map((o) => o.name);

  return {
    program: program.slug,
    display_name: program.display_name,
    period: built.applied.period,
    member_count: built.applied.member_count,
    primary_output: program.primary_output,
    outputs: mainOutputs,
    ...(memberChecks.length > 0 && { member_checks: memberChecks }),
    applied: built.applied,
    citations: citationsFor(mainOutputs),
    incomplete_note: incomplete.length
      ? `Outputs flagged acknowledged_incomplete by the rulespec authors (parts of the rule chain are known to be unfinished): ${incomplete.join(", ")}. Flag this to the user.`
      : null,
  };
}

function citationsFor(outputs: ShapedOutput[]): Array<{ id: string; url: string }> {
  const seen = new Set<string>();
  const citations: Array<{ id: string; url: string }> = [];
  for (const output of outputs) {
    if (!output.legal_id) continue;
    const base = output.legal_id.split("#")[0];
    if (!base.includes(":") || seen.has(base)) continue;
    seen.add(base);
    citations.push({ id: base, url: legalIdToUrl(base) });
  }
  return citations;
}

/** End-to-end compute: build → run → shape. */
export async function computeProgram(options: BuildOptions): Promise<ShapedResult> {
  const built = buildRequest(options);
  const response = await runCompiled(options.program.slug, built.request);
  return shapeResult(options.program, built, response);
}
