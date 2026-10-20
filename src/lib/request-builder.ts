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
  type DerivedTraceNode,
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
import {
  getCatalog,
  slotDefaultAt,
  type CatalogInputSlot,
  type CatalogOutput,
  type CatalogProgram,
  type Requirement,
} from "./catalog";
import { legalIdToUrl } from "./legal-links";
import artifactsLock from "../../artifacts.lock.json";
import { programDisclosures } from "./catalog-overlay";
import type { AssumedMemberSlot } from "./assumed-slots";
import { annualUpdateDisclosure, annualUpdateWarning, overdueAnnualUpdates, periodStartDate } from "./annual-updates";
import { allowanceSlots, allowanceWarning, defaultedAllowanceFlags } from "./added-allowances";

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

export const ASSISTANT_UNSETTABLE_INPUTS: Record<string, Record<string, { state: string; reason?: string }>> = {
  "us-ma-snap": { snap_household_is_categorically_eligible: { state: "Massachusetts" } },
  "us-al-snap": { household_is_categorically_eligible: { state: "Alabama" } },
  "us-tn-snap": { household_is_categorically_eligible: { state: "Tennessee" } },
  "us-az-snap": { na_budgetary_unit_is_eligible: { state: "Arizona", reason: "does not test eligibility yet" } },
  "us-ca-snap": {
    snap_categorically_eligible_for_resource_exemption: {
      state: "California",
      reason: "takes categorical eligibility as an unchecked input (it would apply at any income)",
    },
  },
  "us-ga-snap": {
    member_authorized_to_receive_tanf_community_outreach_services: {
      state: "Georgia",
      reason: "treats TANF community outreach services as categorical eligibility at any income",
    },
    member_receives_tanf_community_outreach_services: {
      state: "Georgia",
      reason: "treats TANF community outreach services as categorical eligibility at any income",
    },
  },
  "us-co-snap": {
    snap_basic_categorical_eligible: {
      state: "Colorado",
      reason: "does not yet apply categorical eligibility exclusions",
    },
    snap_expanded_categorical_eligible: {
      state: "Colorado",
      reason: "does not yet apply categorical eligibility exclusions",
    },
  },
};

export class NotSettableInputError extends Error {
  readonly kind = "not_settable_input";
  constructor(readonly slot: string, readonly path: string, state: string, reason?: string) {
    super(`not settable by the assistant: Axiom's ${state} SNAP encoding ${reason ?? "does not yet determine categorical eligibility from income"}`);
  }
}

/** Facts under members[].facts whose slots are not member-scoped. Member
 *  instances record member-entity slots only, so the engine would never see
 *  them and the answer would compute from their defaults. */
export class NotMemberInputError extends Error {
  readonly kind = "not_member_input";
  constructor(
    readonly misplaced: Array<{ path: string; slot: string; entities: string[] }>,
    readonly memberEntity: string | null,
    programSlug: string
  ) {
    const list = misplaced.map((m) => `${m.path} (${m.entities.join("/")})`).join(", ");
    super(
      memberEntity
        ? `not ${memberEntity} inputs for ${programSlug}: ${list}; members[].facts take ${memberEntity}-scope slots only`
        : `${programSlug} has no member entity, so members[].facts never apply: ${list}`
    );
  }
}

/** members[].relations names that match none of the program's member
 *  relations. Linking keeps only the names that match, so a wrong name linked
 *  the member through no relation and every aggregation over it lost that
 *  member (us-fiit HoH, two kids, $40,000, relations ["dependent"]: EITC
 *  $3,923 became $0). */
export class UnknownRelationError extends Error {
  readonly kind = "unknown_relation";
  constructor(
    readonly unknown: Array<{ path: string; relation: string; suggestions: string[] }>,
    readonly known: string[],
    programSlug: string
  ) {
    const names = [...new Set(unknown.map((u) => `"${u.relation}"`))];
    const closest = [...new Set(unknown.flatMap((u) => u.suggestions))];
    super(
      known.length === 0
        ? `${programSlug} has no member relations, so members[].relations cannot link anything: ${unknown.map((u) => u.path).join(", ")}`
        : `unknown relation ${names.join(", ")} for ${programSlug}` +
          (closest.length ? `; closest relations: ${closest.join(", ")}` : `; member relations: ${known.join(", ")}`)
    );
  }
}

/** Member facts on a slot the program reads on the member entity and on a
 *  non-member entity too (us-fiit filing_status: Person and TaxUnit), with no
 *  top-level value. The member's own record takes the fact; the non-member
 *  instances read only the top-level facts, so they keep the default. */
export class UnitFactUnsetError extends Error {
  readonly kind = "unit_fact_unset";
  constructor(
    readonly unset: Array<{ slot: string; paths: string[]; entities: string[] }>,
    readonly memberEntity: string,
    programSlug: string
  ) {
    super(
      unset
        .map(
          (u) =>
            `${u.paths.join(", ")} set ${u.slot} on ${memberEntity} only; ${programSlug} also reads ${u.slot} on ${u.entities.join("/")}, which keeps its default because the top-level facts do not set it`
        )
        .join("; ")
    );
  }
}

/** members[] on a program with no member entity. No member instances exist,
 *  so the list states a headcount only, which buildRequest writes to the
 *  program's verified count inputs. Raised when that takes a silent choice:
 *  the program has no verified count input (the list would be dropped), or
 *  the caller set one to a different number (two household sizes). */
export class NoMemberEntityError extends Error {
  readonly kind = "no_member_entity";
  constructor(
    readonly memberCount: number,
    readonly countInputs: string[],
    readonly conflicts: Array<{ slot: string; value: FactScalar }>,
    programSlug: string
  ) {
    super(
      conflicts.length > 0
        ? `members[] lists ${memberCount} entries but ${conflicts.map((c) => `${c.slot}=${c.value}`).join(", ")}; ${programSlug} has no member entity, so members[] only sets ${countInputs.join(", ")}`
        : `${programSlug} has no member entity and no recognized household-count input, so members[] (${memberCount} entries) cannot reach the engine`
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
  /** Member-gate judgments auto-queried at every checked member instance. */
  memberCheckNames: Set<string>;
  /** Member instance ids the gates are queried at, in member order. */
  memberCheckIds: string[];
  applied: {
    period: string;
    member_count: number;
    facts_applied: Facts;
    defaulted_slots: number;
    /** Non-aux income-like slots left at a zero default (zero-headline suspects). */
    defaulted_income_slots?: string[];
    /** Curated overlay defaults that sit ON this answer's rule path and were
     *  not overridden by caller facts. Present only when non-empty, so a
     *  question that never touches those rules carries no disclosure noise. */
    overlay_defaults_in_effect?: Facts;
    /** Factual companion slots derived from supplied income, not eligibility. */
    derived_facts?: Facts;
    /** Facts assumed because the user didn't state them (e.g. U.S. citizenship
     *  for SNAP members with no stated citizenship or immigration status).
     *  The answer must disclose each and invite a correction. */
    assumed_facts?: Array<{ slot: string; value: FactScalar; members: number[]; why: string }>;
    /** Computed allowances the rules added on top of a cost slot the caller
     *  set (a SNAP standard utility allowance on
     *  household_shelter_costs_incurred), with the defaults they read. The
     *  amounts sit here as numbers so a reply that states them is grounded
     *  in the tool result; the WARNING note says what to check. */
    added_allowances?: Array<{
      slot: string;
      stated: FactScalar;
      added: Array<{ rule: string; amount: number }>;
      defaults_read: string[];
    }>;
    /** Instructions and diagnostics for the model; not shown to users. */
    notes: string[];
    /** User-facing limitations of this program's encoding, shown on the tool card. */
    disclosures: string[];
  };
}

// Verified headcount inputs in the served catalog: these index household,
// family, and assistance-unit tables or directly count their members. The
// catalog's numeric dtype alone cannot distinguish counts from dollar amounts
// such as poverty_income_guideline_for_household_size.
const MEMBER_COUNT_INPUTS = new Set([
  "household_size",
  "family_size",
  "assistance_unit_size",
  "filing_unit_size",
  "fns_unit_size",
  "tanf_household_size",
  "tanf_family_size",
  // us-ny-tanf only: indexes the grant table; its family_size indexes the
  // shelter allowance, so a household size must reach both.
  "number_of_persons_in_household",
  // us-ga-tanf: au_size, the index of the standard of need, family maximum
  // and gross income ceiling. us-de-tanf: number_people_in_budget, the index
  // of the payment standard table (+$69 per person past 8).
  "assistance_unit_member_count",
  // us-ks-tanf only: indexes the basic allowance and the Table II shelter
  // percentage.
  "assistance_plan_person_count",
  // us-ca-tanf only, three headcounts that must move together: the family
  // count indexes the minimum basic standard (applicant income test), the
  // same-home count indexes the monthly aid payment schedule (the grant), and
  // persons_on_aid indexes the regional MAP tables (auxiliary). Setting the
  // grant's count alone leaves the income test on the one-person standard.
  "eligible_needy_person_count_in_family",
  "eligible_needy_person_count_in_same_home",
  "persons_on_aid",
  // Not assistance_group_size: us-in-tanf indexes its grant by
  // participating_members, so setting the group size alone gives the
  // one-person grant; on us-fl-tca the name is an auxiliary SNAP
  // minimum-benefit size.
  // Not us-co-tanf's caretaker and child counts: its grant chart is indexed
  // by both, so one list length cannot choose between 1+2 ($620) and 2+1
  // ($649).
]);

export function isMemberCountSlot(slot: Pick<CatalogInputSlot, "name" | "dtype">): boolean {
  return MEMBER_COUNT_INPUTS.has(slot.name) && (slot.dtype === "integer" || slot.dtype === "decimal");
}

/** The program's verified count inputs, on any entity. */
export function memberCountSlotNames(program: CatalogProgram): string[] {
  const names = new Set<string>();
  for (const slots of Object.values(program.inputs)) {
    for (const slot of slots) if (isMemberCountSlot(slot)) names.add(slot.name);
  }
  return [...names];
}

/** Fact names that state citizenship or immigration status; any of these on a
 *  member (or at the top level) disables the citizenship assumption. */
const IMMIGRATION_STATUS_FACT =
  /citizen|national|alien|refugee|asylee|entrant|amerasian|immigra|lawful|parolee|compact|qualified_alien|qualifying_quarters|lawfully_residing/;
/** Fact names about an SSN or TIN on the return. */
const SSN_FACT = /(^|_)(ssn|tin)(_|$)|social_security_number/;

/** A member-scope fact the app assumes when the user stated nothing that
 *  bears on it — disclosed in applied.assumed_facts so the answer says so and
 *  invites a correction. */
interface MemberAssumption {
  /** Listed in ASSUMED_MEMBER_SLOTS, so the catalog records which outputs
   *  read it; a lookup whose output doesn't read it discloses nothing. */
  slot: AssumedMemberSlot;
  value: FactScalar;
  applies: (program: CatalogProgram) => boolean;
  /** True when facts (a member's, or the top level's) already speak to
   *  this one; the assumption then stays off for that member. */
  stated: (facts: Facts) => boolean;
  /** The member gate this fact feeds. When the compute checks that gate,
   *  the disclosure keeps only members where it holds — elsewhere the
   *  assumption changed nothing. Without one, a compute always discloses it. */
  gate?: string;
  why: string;
}

const MEMBER_ASSUMPTIONS: MemberAssumption[] = [
  {
    // SNAP: a member with no stated citizenship or immigration status is
    // assumed to be a U.S. citizen. A stated refugee/asylee/LPR status is
    // never overridden.
    slot: "member_is_us_citizen",
    value: true,
    applies: (program) => /-snap$/.test(program.slug),
    stated: (facts) => Object.keys(facts).some((n) => IMMIGRATION_STATUS_FACT.test(n)),
    why: "No citizenship or immigration status was stated, so these members are assumed to be U.S. citizens. Say so in Assumptions and invite the user to correct it.",
  },
  {
    // 26 USC 151(d)(5)(C)(iv): the senior deduction needs the qualified
    // individual's SSN on the return. Filers ordinarily include it, and a
    // compute that omitted the fact headlined a $0 deduction. Setting the
    // slot, or saying that some SSN on the return is missing (an SSN/TIN
    // fact set false), keeps it off.
    slot: "qualified_individual_social_security_number_included_on_return",
    value: true,
    applies: (program) => program.slug === "us-fiit",
    stated: (facts) =>
      "qualified_individual_social_security_number_included_on_return" in facts ||
      Object.entries(facts).some(([n, v]) => SSN_FACT.test(n) && v === false),
    gate: "senior_deduction_qualified_individual",
    why: "Nothing was said about this person's SSN, so it is assumed to be on the return, as the senior deduction requires. Say so in Assumptions and invite the user to correct it (someone filing with an ITIN doesn't qualify).",
  },
];

/** Member-scope slots whose top-level value is the unit's own return, and the
 *  member facts that put a member on that return. us-fiit records
 *  filing_status on Person too: the status of the return the individual
 *  filed. The spouse rules (§151(b) exemption, §151(d)(5) senior deduction)
 *  read the joint status at the spouse; §152(c)(1)(E) reads it at each child
 *  (a child who filed a joint return is no qualifying child). So with an
 *  explicit members list, a top-level fact on such a slot reaches the members
 *  marked with a filer role only. Spread to the children, MFJ failed every
 *  EITC qualifying-child gate and EITC came back $0. */
const RETURN_SCOPED_MEMBER_FACTS: Record<string, { slots: string[]; filerRoles: string[] }> = {
  "us-fiit": { slots: ["filing_status"], filerRoles: ["is_taxpayer", "is_spouse_of_taxpayer"] },
};

export function buildRequest(options: BuildOptions): BuiltRequest {
  const { program } = options;
  const facts = { ...(options.facts ?? {}) };
  const notes: string[] = [];
  const resolved = resolvePeriod(program, options.period);

  // These are free eligibility judgments, not household observations. Reject
  // both values and both fact paths so a retry cannot turn a denial into an
  // over-award or silently override an assumed-eligibility calculation.
  const validateSettable = (supplied: Facts, path: string) => {
    for (const name of Object.keys(supplied)) {
      const blocked = ASSISTANT_UNSETTABLE_INPUTS[program.slug]?.[name];
      if (blocked) throw new NotSettableInputError(name, `${path}.${name}`, blocked.state, blocked.reason);
    }
  };
  validateSettable(options.facts ?? {}, "facts");
  for (const [index, member] of (options.members ?? []).entries()) {
    validateSettable(member.facts ?? {}, `members[${index}].facts`);
  }

  const disclosures = programDisclosures(program);

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
  // Relation names, full or short, must name one of the member relations the
  // members are linked through. An unknown name used to match nothing, so the
  // member was linked through no relation and dropped from every aggregation.
  const memberRelations = program.member_entity
    ? program.relations.filter(
        (r) => r.related_entity === program.member_entity && (r.used || program.relations.length === 1)
      )
    : [];
  const shortName = (name: string) => name.split("#").pop()!.replace(/^relation\./, "");
  const relationNames = new Set(memberRelations.flatMap((r) => [r.name, shortName(r.name)]));
  const knownRelations = [...new Set(memberRelations.map((r) => shortName(r.name)))];
  const unknownRelations: UnknownRelationError["unknown"] = [];
  for (const [index, member] of (options.members ?? []).entries()) {
    for (const [position, relation] of (member.relations ?? []).entries()) {
      if (relationNames.has(relation)) continue;
      unknownRelations.push({
        path: `members[${index}].relations[${position}]`,
        relation,
        suggestions: nearestNames(relation, knownRelations, 3),
      });
    }
  }
  if (unknownRelations.length > 0) throw new UnknownRelationError(unknownRelations, knownRelations, program.slug);
  // Member instances record member-scope slots only, so a member fact on a
  // slot with no member scope (us-fiit's TaxUnit-only
  // taxpayer_includes_required_social_security_number_on_return) would be
  // dropped and the answer computed from its default. Reject it instead of
  // hoisting it to the top level: there it takes one value for the whole
  // unit, and when members disagree with each other or with the top level,
  // picking one is the user's call. A copy equal to the top-level value
  // changes nothing and passes. Slots that also have a member scope keep
  // their per-member records.
  const memberScoped = new Set(
    program.member_entity ? (program.inputs[program.member_entity] ?? []).map((s) => s.name) : []
  );
  const misplaced: NotMemberInputError["misplaced"] = [];
  for (const [index, member] of (options.members ?? []).entries()) {
    for (const [name, value] of Object.entries(member.facts ?? {})) {
      if (memberScoped.has(name) || options.facts?.[name] === value) continue;
      misplaced.push({ path: `members[${index}].facts.${name}`, slot: name, entities: slotEntities.get(name)! });
    }
  }
  if (misplaced.length > 0) throw new NotMemberInputError(misplaced, program.member_entity, program.slug);
  // A slot read on the member entity and on a non-member entity takes a
  // member fact on that member's record only; the non-member instances read
  // the top-level facts. us-fiit filing_status is the one such non-aux slot:
  // under members[0] alone, TaxUnit kept 0, so MFJ regular tax came out
  // $8,528 instead of $7,040 and the $420k CTC $0 instead of $3,400. Reject
  // rather than copy the member value to the unit: on Person it is that
  // individual's own return (§152(c)(1)(E) reads a child's joint return), so
  // a member's value is not always the unit's. The top-level facts stay the
  // one place that sets the unit's value. Auxiliary slots get the warning
  // below.
  const unitUnset = new Map<string, { paths: string[]; entities: string[] }>();
  for (const [index, member] of (options.members ?? []).entries()) {
    for (const name of Object.keys(member.facts ?? {})) {
      if (!memberScoped.has(name) || slotsByName.get(name)!.aux || options.facts?.[name] !== undefined) continue;
      const entities = slotEntities.get(name)!.filter((entity) => entity !== program.member_entity);
      if (entities.length === 0) continue;
      const entry = unitUnset.get(name) ?? { paths: [], entities };
      entry.paths.push(`members[${index}].facts.${name}`);
      unitUnset.set(name, entry);
    }
  }
  if (unitUnset.size > 0) {
    throw new UnitFactUnsetError(
      [...unitUnset].map(([slot, entry]) => ({ slot, ...entry })),
      program.member_entity!,
      program.slug
    );
  }

  const derivedFacts: Facts = {};
  if (program.slug === "us-ny-snap") {
    // New York's 150% path takes this factual companion input. Its actual
    // eligibility threshold remains entirely in the compiled rules engine.
    const earnedSlot = "snap_gross_monthly_earned_income";
    const earned = Number(facts[earnedSlot] ?? slotsByName.get(earnedSlot)?.default ?? 0);
    const hasEarned = earned > 0;
    const slot = "household_has_earned_income_budgeted_for_snap";
    facts[slot] = hasEarned;
    derivedFacts[slot] = hasEarned;
    notes.push(`Derived ${slot}=${hasEarned} from ${earnedSlot}=${earned}; disclose this in Assumptions.`);
    disclosures.push(`New York: the household's earned-income input was set from the earnings given (${hasEarned ? "has" : "no"} earned income).`);
  }

  // Facts landing on auxiliary slots (not reachable from any certified
  // output) silently do nothing to the headline — the classic trap is a
  // plausible sibling name (`countable_monthly_unearned_income` vs the live
  // `snap_total_monthly_unearned_income`). Surface it loudly in the applied
  // report with the nearest on-path sibling. Member facts get the same
  // warning with their members[i] path; one warning per slot.
  const certifiedSlotNames = [...slotsByName.values()].filter((s) => !s.aux).map((s) => s.name);
  const auxPaths = new Map<string, string[]>();
  const noteAux = (name: string, path: string) => {
    if (slotsByName.get(name)?.aux) auxPaths.set(name, [...(auxPaths.get(name) ?? []), path]);
  };
  for (const name of Object.keys(facts)) noteAux(name, "facts");
  for (const [index, member] of (options.members ?? []).entries()) {
    for (const name of Object.keys(member.facts ?? {})) noteAux(name, `members[${index}].facts`);
  }
  for (const [name, paths] of auxPaths) {
    const siblings = nearestNames(name, certifiedSlotNames, 3);
    const where = paths.length === 1 && paths[0] === "facts" ? "" : ` (in ${paths.join(", ")})`;
    notes.push(
      `WARNING: fact "${name}"${where} targets an auxiliary slot that does NOT feed the published outputs — the headline ignores it.` +
        (siblings.length ? ` Did you mean: ${siblings.join(", ")}?` : "")
    );
  }

  // -- Member count ----------------------------------------------------------
  const memberEntity = program.member_entity;
  let memberCount = 0;
  if (memberEntity) {
    if (options.members?.length) {
      memberCount = options.members.length;
    } else {
      const sizeFact = Object.entries(facts).find(
        ([name, value]) => {
          const slot = slotsByName.get(name);
          return slot && isMemberCountSlot(slot) && typeof value === "number" && value >= 1;
        }
      );
      memberCount = sizeFact ? Math.min(20, Math.floor(sizeFact[1] as number)) : 1;
      if (sizeFact) notes.push(`synthesized ${memberCount} ${memberEntity} member(s) from ${sizeFact[0]}`);
    }
    // Keep verified count inputs consistent with an explicit members list.
    if (options.members?.length) {
      for (const slot of slotsByName.values()) {
        if (isMemberCountSlot(slot) && facts[slot.name] === undefined) {
          facts[slot.name] = memberCount;
          notes.push(`set ${slot.name}=${memberCount} to match members[]`);
        }
      }
    }
  } else if (options.members?.length) {
    // No member entity: no member instances exist and member facts were
    // rejected above, so the list states a headcount only. Write it to the
    // verified count inputs as the member-entity path does, so a household
    // given through members[] never computes at the count's default (us-ny-tanf
    // gave $183.10 for one person, not $389 for three). Refuse when that takes
    // a silent choice: with no count input the list would be dropped, and a
    // count fact that differs from the list is a second household size only
    // the caller can reconcile (an assistance unit can be smaller than the
    // household).
    const size = options.members.length;
    const countInputs = memberCountSlotNames(program);
    const conflicts = countInputs
      .filter((name) => facts[name] !== undefined && Number(facts[name]) !== size)
      .map((name) => ({ slot: name, value: facts[name] }));
    if (countInputs.length === 0 || conflicts.length > 0) {
      throw new NoMemberEntityError(size, countInputs, conflicts, program.slug);
    }
    for (const name of countInputs) {
      if (facts[name] !== undefined) continue;
      facts[name] = size;
      notes.push(`set ${name}=${size} from members[]: ${program.slug} has no member entity, so members[] sets only the household count`);
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
  // Auto-queried per member so a compute with members shows WHY each member
  // did or didn't count — with `requires` attached on failure. Every explicit
  // member is checked: the taxpayer listed first fails the qualifying-child
  // gate the children hold, so member 1 alone reads as "no qualifying child".
  // Synthesized members past the first carry only defaults; check member 1.
  const memberCheckNames = new Set<string>();
  const memberCheckIds: string[] = [];
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
    if (memberCheckNames.size > 0) {
      const checked = options.members?.length ? memberCount : 1;
      for (let i = 1; i <= checked; i++) memberCheckIds.push(instanceId(memberEntity, i));
    }
  }

  // -- Annual updates past due ----------------------------------------------
  // A period on or after the date an annually reissued parameter was due
  // (e.g. SNAP's October 1 COLA) still evaluates last year's version when the
  // release doesn't carry the new one. Disclose it rather than answer as if
  // current; outputs that don't reach such a parameter never trigger this.
  const overdue = overdueAnnualUpdates(
    program,
    queried.map((output) => ({ output, periodStart: periodForOutput(output, resolved, program).interval.start }))
  );
  for (const update of overdue) {
    disclosures.push(annualUpdateDisclosure(program, update));
    notes.push(annualUpdateWarning(update, resolved.label));
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
  // Non-aux income-like slots left at a zero default: if the primary output
  // comes back $0, these are the usual suspects (see shapeResult's warning).
  const INCOME_SLOT = /(taxable|gross|earned|countable|unearned|net)_income/;
  const defaultedIncomeSlots = new Set<string>();

  // Defaults that change on a date (a provision's sunset) resolve at the
  // start of the evaluated period.
  const defaultFor = (slot: CatalogInputSlot) => slotDefaultAt(slot, inputInterval.start);

  const record = (slot: CatalogInputSlot, entity: string, entityId: string, override?: FactScalar) => {
    const value = override !== undefined ? override : defaultFor(slot);
    if (override === undefined) {
      defaultedSlots++;
      if (!slot.aux && value === 0 && INCOME_SLOT.test(slot.name)) {
        defaultedIncomeSlots.add(slot.name);
      }
    }
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
  /** Assumption → the 1-based members it was set on. */
  const assumedMembers = new Map<MemberAssumption, number[]>();
  if (memberEntity && memberCount > 0) {
    const memberSlots = program.inputs[memberEntity] ?? [];

    // Top-level facts that name member-scope slots: with an explicit
    // members[] they form the shared base for EVERY member (taxpayer-level
    // facts like SSN-on-return are member-scoped in the IR but identical
    // across members) except return-scoped slots, which reach filer-role
    // members only (RETURN_SCOPED_MEMBER_FACTS); with synthesized members
    // they go to member 1 only (primary-applicant semantics, e.g.
    // oldest_member_age).
    const explicitMembers = (options.members?.length ?? 0) > 0;
    const returnScoped = explicitMembers ? RETURN_SCOPED_MEMBER_FACTS[program.slug] : undefined;
    const withheld = new Map<string, number[]>(); // slot → members it did not reach
    // Facts the user never spoke to are assumed per member (see
    // MEMBER_ASSUMPTIONS) and disclosed in applied.assumed_facts. A related
    // fact on the member or at the top level keeps an assumption off.
    const assumptions = MEMBER_ASSUMPTIONS.filter(
      (a) => a.applies(program) && memberSlots.some((s) => s.name === a.slot) && !a.stated(facts)
    );
    const applyAssumptions = (memberFacts: Facts, member: number) => {
      for (const assumption of assumptions) {
        if (assumption.stated(memberFacts)) continue;
        memberFacts[assumption.slot] = assumption.value;
        if (!assumedMembers.has(assumption)) assumedMembers.set(assumption, []);
        assumedMembers.get(assumption)!.push(member);
      }
    };
    for (let i = 0; i < memberCount; i++) {
      const memberId = instanceId(memberEntity, i + 1);
      const spec = options.members?.[i];
      const base = explicitMembers || i === 0 ? topLevelMemberFacts() : {};
      if (returnScoped) {
        const own = { ...base, ...(spec?.facts ?? {}) };
        if (!returnScoped.filerRoles.some((role) => own[role] === true)) {
          for (const slot of returnScoped.slots) {
            if (!(slot in base)) continue;
            delete base[slot];
            if (spec?.facts?.[slot] !== undefined) continue; // the member's own value applies
            if (!withheld.has(slot)) withheld.set(slot, []);
            withheld.get(slot)!.push(i + 1);
          }
        }
      }
      const memberFacts: Facts = { ...base, ...(spec?.facts ?? {}) };
      applyAssumptions(memberFacts, i + 1);
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
    for (const [slot, members] of withheld) {
      notes.push(
        `top-level ${slot}=${facts[slot]} describes the ${program.primary_entity}'s own return, so it was recorded on members with ${returnScoped!.filerRoles.join(" or ")} true and not on member(s) ${members.join(", ")}; their own ${slot} stays at its default.`
      );
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

    // The reverse direction: a non-member rule can read a member-entity rule
    // directly, without a relation aggregator (us-fiit's senior-deduction
    // MAGI, a TaxUnit rule, adds the §911 exclusion, a Person rule). The
    // engine then evaluates that rule at the query instance itself, so its
    // member-scope inputs must resolve there. Mirror member 1's values — the
    // primary filer/applicant — onto every non-member query instance; slots
    // that already have a non-member-scope record keep it. The records keep
    // the slot's own entity: the engine resolves inputs by entity_id only.
    const member1Facts: Facts = {
      ...topLevelMemberFacts(),
      ...(options.members?.[0]?.facts ?? {}),
    };
    for (const [assumption, members] of assumedMembers) {
      if (members.includes(1)) member1Facts[assumption.slot] = assumption.value;
    }
    for (const entityId of queryInstances.values()) {
      for (const slot of memberSlots) {
        if (nonMemberSlots.has(slot.name)) continue;
        record(slot, memberEntity, entityId, member1Facts[slot.name]);
      }
    }

    // Member-check queries evaluate member-entity judgments at each checked
    // member; any household-scope inputs those rule chains read must resolve
    // there too. Add the non-member union to each checked member, excluding
    // slots that already have member-scope records (duplicates with
    // conflicting values would be ambiguous).
    if (memberCheckNames.size > 0) {
      const memberSlotNames = new Set(memberSlots.map((s) => s.name));
      for (const memberId of memberCheckIds) {
        for (const slot of nonMemberSlots.values()) {
          if (memberSlotNames.has(slot.name)) continue;
          record(slot, memberEntity, memberId, facts[slot.name]);
        }
      }
    }
  }

  // -- Queries grouped by (entity_id, period) --------------------------------
  const queryGroups = new Map<string, QueryRequest>();
  for (const output of queried) {
    const { period } = periodForOutput(output, resolved, program);
    const entityIds = memberCheckNames.has(output.name)
      ? memberCheckIds
      : [
          output.entity === memberEntity && memberEntity
            ? instanceId(memberEntity, 1)
            : queryInstances.get(output.entity) ?? primaryId,
        ];
    for (const entityId of entityIds) {
      const key = `${entityId}|${period.period_kind}|${period.start}`;
      if (!queryGroups.has(key)) {
        queryGroups.set(key, { entity_id: entityId, period, outputs: [] });
      }
      queryGroups.get(key)!.outputs.push(queryKey(output));
    }
  }

  // Member-scope inputs for member queries: if a queried output lives on the
  // member entity, the first member instance already has its slots.

  // A lookup (outputsOverride) discloses an assumption only when a queried
  // output's rule chain reads the slot (the catalog's read_by): every us-fiit
  // lookup listed the SSN assumption, exemption_amount included, which never
  // reads it. A slot without read_by stays disclosed. Computes keep every
  // assumption here; shapeResult narrows them by the member gate.
  const disclosedAssumptions = [...assumedMembers].filter(([assumption]) => {
    if (!options.outputsOverride) return true;
    const readers = program.inputs[memberEntity ?? ""]?.find((s) => s.name === assumption.slot)?.read_by;
    return !readers || queried.some((o) => readers.includes(o.name));
  });

  return {
    request: {
      mode: options.mode ?? "explain",
      dataset: { inputs, relations },
      queries: [...queryGroups.values()],
    },
    queried,
    memberCheckNames,
    memberCheckIds,
    applied: {
      period: resolved.label,
      member_count: memberCount,
      facts_applied: facts,
      ...(Object.keys(derivedFacts).length > 0 && { derived_facts: derivedFacts }),
      ...(disclosedAssumptions.length > 0 && {
        assumed_facts: disclosedAssumptions.map(([assumption, members]) => ({
          slot: assumption.slot,
          value: assumption.value,
          members,
          why: assumption.why,
        })),
      }),
      defaulted_slots: defaultedSlots,
      ...(defaultedIncomeSlots.size > 0 && {
        defaulted_income_slots: [...defaultedIncomeSlots],
      }),
      ...(() => {
        // Disclose overlay defaults only when the slot can actually reach the
        // queried answer (non-aux) and the caller didn't set it themselves.
        const userSet = new Set([
          ...Object.keys(options.facts ?? {}),
          ...(options.members ?? []).flatMap((m) => Object.keys(m.facts ?? {})),
        ]);
        const inEffect: Facts = {};
        for (const slots of Object.values(program.inputs)) {
          for (const s of slots) {
            if (s.default_source === "overlay" && !s.aux && !userSet.has(s.name)) {
              inEffect[s.name] = defaultFor(s);
            }
          }
        }
        return Object.keys(inEffect).length > 0 ? { overlay_defaults_in_effect: inEffect } : {};
      })(),
      notes,
      disclosures,
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
  /** One of the program's outputs listed in the release manifest. */
  published_output: boolean;
  acknowledged_incomplete: boolean;
  legal_id: string | null;
  /** Attached when a judgment came back not_holds: the facts (with values)
   *  its unconditional conjunction chain requires that the inputs recorded
   *  where it ran don't meet — what to set to make it hold. Entries already
   *  met there are left out. An entry with `op` is a threshold the slot's
   *  real value must meet (`age gte 65`). `requires_partial` marks
   *  additional conditional/disjunctive logic not captured here. */
  requires?: CatalogOutput["requires"];
  /** Attached with a not_holds judgment: the `or`s in its chain that are
   *  still unmet — no alternative group holds on the recorded inputs and the
   *  trace doesn't show the enclosing rule holding. */
  requires_any?: CatalogOutput["requires_any"];
  requires_partial?: boolean;
  /** Attached when a judgment came back not_holds and the explain trace
   *  shows why: the deepest sub-judgments on its failing path, with their
   *  legal ids and sources (e.g. snap_member_eligible ←
   *  snap_member_citizenship_or_alien_status_eligible, 7 CFR 273.4(a)). */
  failed_because?: Array<{ name: string; legal_id: string | null; source: string | null }>;
  /** Attached when a scalar came back 0 because a judgment gating it failed
   *  (the catalog's `zero_unless`: us-fiit `eitc` ← `eitc_allowed`). Each
   *  entry reads like a failed judgment output. Member gates are left to
   *  `member_checks`, and gates that are outputs of their own to their entry. */
  zero_because?: GateCheck[];
}

/** One leaf of a rule's dependency closure: a parameter or an unconditioned
 *  input the rule ultimately rests on. */
export interface ProvenanceParameter {
  legal_id: string | null;
  name: string;
  value: unknown;
  source: string | null;
}

/** The derivation behind one output: every rule legal id the engine actually
 *  fired to produce it (BFS order, root first) and the parameters/inputs at
 *  the bottom of that chain. Derived from the `explain`-mode trace — see
 *  `deriveRuleProvenance` — never derived from anywhere else. */
export interface RuleProvenance {
  rule_path: string[];
  parameters_used: ProvenanceParameter[];
}

/** Reproducibility stamps for one compute: which corpus and engine build
 *  produced it, and when. `release_tag`/`corpus_sha` come from the catalog
 *  (itself pinned by `artifacts.lock.json` at catalog-generation time);
 *  `engine_ref` is read from the same lock file directly since it isn't
 *  otherwise threaded into the runtime. */
export interface Stamps {
  release_tag: string;
  corpus_sha: string;
  engine_ref: string;
  evaluated_at: string;
}

export function computeStamps(): Stamps {
  const catalog = getCatalog();
  return {
    release_tag: catalog.release_tag,
    corpus_sha: catalog.corpus_sha,
    engine_ref: (artifactsLock as { engine: { ref: string } }).engine.ref,
    evaluated_at: new Date().toISOString(),
  };
}

/** Walk a trace node's `dependencies` breadth-first from `rootKey`, collecting
 *  every fired rule's legal id (`rule_path`) and the leaf nodes it ultimately
 *  rests on (`parameters_used`). A dependency key absent from `trace` is a
 *  short-circuited sibling branch the engine never evaluated — signal, not
 *  error, so it's skipped rather than throwing. */
export function deriveRuleProvenance(
  trace: Record<string, DerivedTraceNode>,
  rootKey: string
): RuleProvenance {
  const visited = new Set<string>();
  const queue: string[] = [rootKey];
  const rulePath: string[] = [];
  const parametersUsed: ProvenanceParameter[] = [];
  while (queue.length) {
    const key = queue.shift()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = trace[key];
    if (!node) continue; // short-circuited branch never evaluated
    if (node.id) rulePath.push(node.id);
    if (!node.dependencies || node.dependencies.length === 0) {
      parametersUsed.push({
        legal_id: node.id ?? null,
        name: node.name,
        value: node.kind === "judgment" ? node.outcome ?? null : node.value?.value ?? null,
        source: node.source ?? null,
      });
    } else {
      for (const dep of node.dependencies) queue.push(dep);
    }
  }
  return { rule_path: rulePath, parameters_used: parametersUsed };
}

/** Follow a failed judgment's not_holds sub-judgments down the explain trace
 *  and return the deepest ones — the conditions that actually failed, which
 *  the top-level gate alone doesn't name. Empty when the trace doesn't reach
 *  a failing sub-judgment (e.g. the judgment failed on an input directly).
 *  A sub-judgment the parent reads negated (`negated`, from the catalog) is
 *  skipped: its failing is no reason the parent failed. */
function failingSubJudgments(
  trace: Record<string, DerivedTraceNode>,
  key: string,
  name: string,
  negated: (judgment: string) => readonly string[] | undefined,
  limit = 5
): NonNullable<ShapedOutput["failed_because"]> {
  const rootKey = trace[key] ? key : trace[name] ? name : null;
  if (!rootKey) return [];
  const found: NonNullable<ShapedOutput["failed_because"]> = [];
  const seen = new Set<string>();
  const visit = (k: string) => {
    if (seen.has(k) || found.length >= limit) return;
    seen.add(k);
    const node = trace[k];
    if (!node) return;
    const skipped = negated(node.name) ?? [];
    const failing = node.dependencies.filter(
      (d) => trace[d]?.kind === "judgment" && trace[d]?.outcome === "not_holds" && !skipped.includes(trace[d].name)
    );
    if (failing.length === 0) {
      if (k !== rootKey && !found.some((f) => f.name === node.name)) {
        found.push({ name: node.name, legal_id: node.id ?? null, source: node.source ?? null });
      }
      return;
    }
    failing.forEach(visit);
  };
  visit(rootKey);
  return found;
}

/** Trace keys reachable from `rootKey` through `dependencies`. */
function reachableKeys(trace: Record<string, DerivedTraceNode>, rootKey: string): Set<string> {
  const reached = new Set<string>();
  const queue = [rootKey];
  while (queue.length) {
    const key = queue.shift()!;
    if (reached.has(key) || !trace[key]) continue;
    reached.add(key);
    queue.push(...trace[key].dependencies);
  }
  return reached;
}

/** Unmet `or`s shown per failed judgment; the catalog keeps up to six. */
const OPEN_ALTERNATIVES_CAP = 3;

/** One unpublished gate judgment (a member gate, or a gate that zeroed a
 *  scalar), with the ShapedOutput fields that would repeat per gate (label,
 *  unit, semantics, entity, ...) left out. */
export type GateCheck = Pick<
  ShapedOutput,
  "name" | "value" | "legal_id" | "requires" | "requires_any" | "requires_partial" | "failed_because"
>;

/** One member-gate judgment at one member. */
export type MemberCheck = GateCheck;

function asGateCheck(shaped: ShapedOutput): GateCheck {
  const { name, value, legal_id, requires, requires_any, requires_partial, failed_because } = shaped;
  return {
    name,
    value,
    legal_id,
    ...(requires && { requires }),
    ...(requires_any && { requires_any }),
    ...(requires_partial && { requires_partial }),
    ...(failed_because && { failed_because }),
  };
}

/** Exactly one of `checks` / `same_as` is set: a member whose checks match
 *  an earlier member's points at that member instead of repeating them
 *  (siblings, or six identical SNAP members, would otherwise multiply the
 *  payload). */
export interface MemberChecks {
  /** 1-based position in the request's members list. */
  member: number;
  checks?: MemberCheck[];
  /** The earlier member whose checks this member's equal, value for value. */
  same_as?: number;
}

export interface ShapedResult {
  program: string;
  display_name: string;
  period: string;
  member_count: number;
  primary_output: string;
  outputs: ShapedOutput[];
  /** Per member, the judgments gating whether that member counts inside
   *  relation aggregators, with `requires` (the facts to set) and
   *  `failed_because` attached on failure. */
  member_checks?: MemberChecks[];
  applied: BuiltRequest["applied"];
  citations: Array<{ id: string; url: string }>;
  incomplete_note: string | null;
  /** Per-output derivation, keyed by output name. Sized for a UI panel
   *  (20–50 KB of raw trace collapses to a rule-id list + leaf parameters
   *  per output) — never meant to ride in a tool result back to the model;
   *  callers strip this before returning to the model and forward it
   *  out-of-band instead (see route.ts's stream annotations). */
  provenance: Record<string, RuleProvenance>;
  stamps: Stamps;
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
  type ReadOutput = ReturnType<typeof readOutput>;
  // Main outputs read one merged view. Members past the first carry only
  // gate queries whose outputs and trace nodes share keys across members, so
  // each checked member also gets its own scope.
  const merged = new Map<string, ReadOutput>();
  const trace: Record<string, DerivedTraceNode> = {};
  const checkedIds = new Set(built.memberCheckIds);
  const gateOnlyIds = new Set(built.memberCheckIds.slice(1));
  const perMember = new Map<string, { outputs: Map<string, ReadOutput>; trace: Record<string, DerivedTraceNode> }>();
  for (const result of response.results) {
    if (checkedIds.has(result.entity_id)) {
      let scope = perMember.get(result.entity_id);
      if (!scope) perMember.set(result.entity_id, (scope = { outputs: new Map(), trace: {} }));
      for (const [key, value] of Object.entries(result.outputs ?? {})) scope.outputs.set(key, readOutput(value));
      Object.assign(scope.trace, result.trace ?? {});
    }
    if (gateOnlyIds.has(result.entity_id)) continue;
    for (const [key, value] of Object.entries(result.outputs ?? {})) {
      merged.set(key, readOutput(value));
    }
    Object.assign(trace, result.trace ?? {});
  }

  // Recorded input values by `entity_id|legal input id`, to tell which
  // `requires_any` alternatives already hold. A slot recorded twice with
  // different values counts as unknown.
  const recorded = new Map<string, string | undefined>();
  for (const input of built.request.dataset.inputs) {
    const key = `${input.entity_id}|${input.name}`;
    const value = String(input.value.value);
    recorded.set(key, recorded.has(key) && recorded.get(key) !== value ? undefined : value);
  }
  // A `computed` entry names a derived value: read it from the trace (absent
  // when the engine short-circuited it, so unknown).
  const tracedValue = (scopeTrace: Record<string, DerivedTraceNode>, name: string): string | undefined => {
    const node = Object.values(scopeTrace).find((n) => n.name === name && n.kind === "scalar");
    return node?.value === undefined ? undefined : String(node.value.value);
  };
  const meets = (
    entityId: string | undefined,
    req: Requirement,
    scopeTrace: Record<string, DerivedTraceNode>
  ): boolean => {
    const value = req.computed
      ? tracedValue(scopeTrace, req.slot)
      : recorded.get(`${entityId}|${legalInputId(program.slug, req.slot)}`);
    if (value === undefined) return false;
    if (!req.op) return value === String(req.value);
    const [n, t] = [Number(value), Number(req.value)];
    return req.op === "gt" ? n > t : req.op === "gte" ? n >= t : req.op === "lt" ? n < t : n <= t;
  };
  const openAlternatives = (
    output: CatalogOutput,
    entityId: string | undefined,
    scopeTrace: Record<string, DerivedTraceNode>
  ): NonNullable<ShapedOutput["requires_any"]> => {
    if (!output.requires_any) return [];
    const holding = new Set(Object.values(scopeTrace).filter((n) => n.outcome === "holds").map((n) => n.name));
    return output.requires_any
      .filter((alt) => !holding.has(alt.rule) && !alt.any_of.some((group) => group.every((req) => meets(entityId, req, scopeTrace))))
      .slice(0, OPEN_ALTERNATIVES_CAP);
  };
  const mainEntityOf = new Map<string, string>();
  for (const query of built.request.queries) {
    if (gateOnlyIds.has(query.entity_id)) continue;
    for (const key of query.outputs) if (!mainEntityOf.has(key)) mainEntityOf.set(key, query.entity_id);
  }

  // A scalar that is `if J then X else 0` comes back 0 with no failed check
  // when J is neither an output nor a member gate: us-fiit's eitc fails
  // eitc_allowed on an unset taxpayer SSN fact, and the result named nothing
  // to set. Shape each failed J on the 0's own trace path like a failed
  // judgment output.
  const outputByName = new Map(program.outputs.map((o) => [o.name, o]));
  const reported = new Set(built.queried.map((o) => o.name));
  const failedZeroGates = (
    output: CatalogOutput,
    scopeTrace: Record<string, DerivedTraceNode>,
    entityId: string | undefined
  ): GateCheck[] => {
    const reached = reachableKeys(scopeTrace, queryKey(output));
    return (output.zero_unless ?? []).flatMap((name) => {
      const gate = outputByName.get(name);
      if (!gate || gate.entity === program.member_entity || reported.has(name)) return [];
      const key = queryKey(gate);
      if (!reached.has(key) || scopeTrace[key].outcome !== "not_holds") return [];
      const outcome = new Map<string, ReadOutput>([[key, { kind: "judgment", outcome: "not_holds" }]]);
      return [asGateCheck(shapeOne(gate, outcome, scopeTrace, entityId))];
    });
  };

  const shapeOne = (
    output: CatalogOutput,
    outputs: Map<string, ReadOutput>,
    scopeTrace: Record<string, DerivedTraceNode>,
    entityId = mainEntityOf.get(queryKey(output))
  ): ShapedOutput => {
    const r = outputs.get(queryKey(output));
    let value: ShapedOutput["value"] = null;
    if (r) value = r.kind === "judgment" ? r.outcome ?? null : r.numeric ?? null;
    const failedJudgment = output.semantics === "judgment" && value === "not_holds";
    const failedBecause = failedJudgment
      ? failingSubJudgments(scopeTrace, queryKey(output), output.name, (name) => outputByName.get(name)?.negated_judgments)
      : [];
    const open = failedJudgment ? openAlternatives(output, entityId, scopeTrace) : [];
    // Name only the requirements this entity's own inputs fail. us-fiit's
    // 24(h)(7) test reads the taxpayer/spouse SSN facts on each child's
    // record; gpt-6-luna set them on the parents, saw all five SSN facts it
    // had set somewhere listed, and accepted the $500 other-dependent credit
    // (MFJ, two children, $420,000: $0 instead of $3,400).
    const unmet = failedJudgment ? (output.requires ?? []).filter((req) => !meets(entityId, req, scopeTrace)) : [];
    const zeroBecause = value === 0 ? failedZeroGates(output, scopeTrace, entityId) : [];
    return {
      name: output.name,
      label: labelFor(output.name),
      value,
      unit: output.unit,
      semantics: output.semantics,
      entity: output.entity,
      published_output: output.certified,
      acknowledged_incomplete: output.acknowledged_incomplete,
      legal_id: output.id,
      ...(unmet.length > 0 && { requires: unmet }),
      ...(open.length > 0 && { requires_any: open }),
      ...(failedJudgment && (output.requires || open.length > 0) && output.requires_partial && {
        requires_partial: true,
      }),
      ...(failedBecause.length > 0 && { failed_because: failedBecause }),
      ...(zeroBecause.length > 0 && { zero_because: zeroBecause }),
    };
  };

  const mainOutputs = built.queried
    .filter((o) => !built.memberCheckNames.has(o.name))
    .map((o) => shapeOne(o, merged, trace));

  const gates = built.queried.filter((o) => built.memberCheckNames.has(o.name));
  const firstMemberWith = new Map<string, number>();
  const heldAt = new Set<string>(); // `${gate}|${member}` for every gate that holds
  const memberChecks: MemberChecks[] = built.memberCheckIds.map((id, index) => {
    const member = index + 1;
    const scope = perMember.get(id) ?? { outputs: new Map<string, ReadOutput>(), trace: {} };
    const checks: MemberCheck[] = gates.map((gate) => {
      const check = asGateCheck(shapeOne(gate, scope.outputs, scope.trace, id));
      if (check.value === "holds") heldAt.add(`${check.name}|${member}`);
      return check;
    });
    const signature = JSON.stringify(checks);
    const sameAs = firstMemberWith.get(signature);
    if (sameAs !== undefined) return { member, same_as: sameAs };
    firstMemberWith.set(signature, member);
    return { member, checks };
  });

  // An assumption tied to a member gate changed nothing where that gate
  // fails anyway (a 40-year-old's senior-deduction check), so disclose it
  // only where the gate holds. Members whose gate wasn't checked (the
  // lookup path, synthesized members past the first) stay disclosed; a
  // lookup already dropped assumptions its output doesn't read.
  if (built.applied.assumed_facts) {
    const disclosed = built.applied.assumed_facts
      .map((assumed) => {
        const gate = MEMBER_ASSUMPTIONS.find((a) => a.slot === assumed.slot)?.gate;
        if (!gate || !built.memberCheckNames.has(gate)) return assumed;
        const members = assumed.members.filter(
          (m) => m > built.memberCheckIds.length || heldAt.has(`${gate}|${m}`)
        );
        return { ...assumed, members };
      })
      .filter((assumed) => assumed.members.length > 0);
    if (disclosed.length > 0) built.applied.assumed_facts = disclosed;
    else delete built.applied.assumed_facts;
  }

  // Primary first, then judgments, then remaining scalars.
  mainOutputs.sort((a, b) => {
    const rank = (o: ShapedOutput) =>
      o.name === program.primary_output ? 0 : o.semantics === "judgment" ? 1 : 2;
    return rank(a) - rank(b);
  });

  const incomplete = mainOutputs.filter((o) => o.acknowledged_incomplete).map((o) => o.name);

  // A $0 primary output while income-like slots sat at their zero defaults is
  // the classic spurious-zero: the engine faithfully computed from zeros the
  // user never asserted. Flag it loudly so the model asks instead of headlining.
  const primary = mainOutputs.find((o) => o.name === program.primary_output);
  const suspects = built.applied.defaulted_income_slots ?? [];
  const userGaveIncome = Object.keys(built.applied.facts_applied).some((n) =>
    /(income|wages|earnings|compensation)/.test(n)
  );
  if (typeof primary?.value === "number" && primary.value === 0 && suspects.length > 0 && userGaveIncome) {
    built.applied.notes.push(
      `WARNING: ${program.primary_output} is $0, but income-like slot(s) ${suspects.join(", ")} stayed at their 0 defaults — the engine computed from zeros the user never asserted. Do NOT headline this $0. Derive the missing slot ONLY from values a tool returned in this conversation; if none exists, make asking for it your headline — never fill it from remembered law, even disclosed as an assumption. Only present $0 if the user's facts genuinely imply the slot is zero, and say so explicitly. Outputs that do NOT depend on the zeroed slot (e.g. credits computed from earned income or AGI) are still reliable — report those normally alongside the ask. (If this call was a variant run for a delta and your main computation already has the slot filled, the warning is expected — keep the main answer and do NOT rerun this variant.)`
    );
  }

  // A cost slot the rules add an allowance to (household_shelter_costs_incurred
  // + a SNAP standard utility allowance) must not already hold the costs the
  // allowance stands in for. Whether the caller's figure does is in the
  // user's words, not the numbers, so say what the rules added and let the
  // model check: "rent $900, utility allowance $323" sent as 1,223 got the
  // $323 a second time (us-az-snap $298 instead of $219).
  const periodStart = periodStartDate(built.applied.period);
  for (const slot of allowanceSlots(program)) {
    const stated = built.applied.facts_applied[slot.name];
    if (stated === undefined) continue;
    const added = slot.added_allowances
      .map((a) => ({ rule: a.rule, amount: Number(tracedValue(trace, a.rule) ?? 0) }))
      .filter((a) => a.amount > 0);
    if (added.length === 0) continue;
    const defaults = defaultedAllowanceFlags(program, slot, periodStart, built.applied.facts_applied);
    (built.applied.added_allowances ??= []).push({ slot: slot.name, stated, added, defaults_read: defaults });
    built.applied.notes.push(allowanceWarning(slot, stated, added, defaults));
  }

  const provenance: Record<string, RuleProvenance> = {};
  for (const output of built.queried) {
    const key = queryKey(output);
    if (!trace[key]) continue; // no trace root — e.g. output never fired
    provenance[output.name] = deriveRuleProvenance(trace, key);
  }

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
      ? `Flagged in the program spec as not fully encoded: ${incomplete.join(", ")}.`
      : null,
    provenance,
    stamps: computeStamps(),
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
