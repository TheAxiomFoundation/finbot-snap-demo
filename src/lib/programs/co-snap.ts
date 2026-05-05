/**
 * Colorado SNAP — typed user-facing fact contract bound to axiom-rules legal IDs.
 *
 * The schema (every input the program reaches, per entity, with dtype) comes
 * from {@link CO_SNAP_BASE}, which is auto-generated from the compiled program
 * IR. The runtime never maintains a hand-written list of inputs — when the
 * upstream RuleSpec changes, regenerating the base file picks up the diff.
 *
 * What this module owns is only the small, intentional surface of "user-facing
 * facts" — the handful of things the chat layer actually asks the user about
 * — and a mapping from those facts onto the underlying input slot names.
 */
import { CO_SNAP_BASE } from "./co-snap-base";
import {
  type ExecutionRequest,
  type ExecutionResponse,
  type FactScalar,
  type InputRecord,
  fact,
  monthInterval,
  readOutput,
  runCompiled,
} from "../engine";

const ARTIFACT_SLUG = "co-snap";

/** The friendly fact contract the LLM tools speak. Each maps to one or more
 *  underlying input slot names in {@link FRIENDLY_TO_SLOT}. This list is
 *  intentionally small — it's the user-facing surface, not the rule schema. */
export interface CoSnapFacts {
  period?: string;
  household_size?: number;
  monthly_earnings_per_adult?: number;
  monthly_unearned_income?: number;
  monthly_shelter_costs?: number;
  pays_separate_heating_or_cooling?: boolean;
  liquid_resources?: number;
  oldest_member_age?: number;
  any_member_elderly_or_disabled?: boolean;
  primary_member_is_us_citizen?: boolean;
}

/** Map a friendly fact onto one or more input-slot names that the engine knows.
 *  An entry can be: `string` (single household-scope slot) or
 *  `{ household?: string[]; person?: string[] }` for fan-out into multiple
 *  slots and/or onto the primary member. */
type SlotBinding = string | { household?: string[]; person?: string[] };

const FRIENDLY_TO_SLOT: Record<keyof CoSnapFacts, SlotBinding | null> = {
  period: null, // handled separately as the query interval
  household_size: "household_size",
  monthly_earnings_per_adult: "employee_wages_received",
  monthly_unearned_income: "assistance_payments",
  monthly_shelter_costs: "household_shelter_costs_incurred",
  pays_separate_heating_or_cooling:
    "household_incurred_or_anticipated_heating_or_cooling_costs_separate_from_rent_or_mortgage",
  liquid_resources: "liquid_resource_current_redemption_rate",
  oldest_member_age: { person: ["member_age"] },
  any_member_elderly_or_disabled: { person: ["snap_member_is_elderly_or_disabled"] },
  primary_member_is_us_citizen: { person: ["member_is_us_citizen"] },
};

const RELATION_MEMBER_OF_HOUSEHOLD =
  "us:statutes/7/2012/j#relation.member_of_household";

// Engine accepts any legal-id-shaped reference; only the `input.<NAME>`
// fragment matters for resolution. We use a synthetic prefix for inputs that
// the test fixture didn't anchor to a specific legal source — citations still
// surface the real source via output IDs in the response.
const SYNTHETIC_INPUT_PREFIX = "axiom:co-snap-fy-2026#input.";

function legalInputId(slotName: string): string {
  return SYNTHETIC_INPUT_PREFIX + slotName;
}

/** Apply user-facing overrides to the auto-generated base schema. */
function applyOverrides(facts: CoSnapFacts): {
  household_overrides: Record<string, FactScalar>;
  primary_member_overrides: Record<string, FactScalar>;
  resolved: CoSnapFacts;
} {
  const resolved: CoSnapFacts = {
    period: facts.period ?? "2026-01",
    household_size: facts.household_size ?? 1,
    ...facts,
  };

  const household_overrides: Record<string, FactScalar> = {};
  const primary_member_overrides: Record<string, FactScalar> = {};

  for (const [factKey, binding] of Object.entries(FRIENDLY_TO_SLOT)) {
    if (binding == null) continue;
    const value = (resolved as Record<string, unknown>)[factKey];
    if (value === undefined) continue;
    if (typeof binding === "string") {
      household_overrides[binding] = value as FactScalar;
    } else {
      for (const slot of binding.household ?? []) {
        household_overrides[slot] = value as FactScalar;
      }
      for (const slot of binding.person ?? []) {
        primary_member_overrides[slot] = value as FactScalar;
      }
    }
  }

  return { household_overrides, primary_member_overrides, resolved };
}

/** Build the engine ExecutionRequest. */
function buildRequest(facts: CoSnapFacts, mode: "fast" | "explain" = "explain"): {
  request: ExecutionRequest;
  resolved: CoSnapFacts;
} {
  const { household_overrides, primary_member_overrides, resolved } = applyOverrides(facts);
  const period = resolved.period!;
  const { interval, period: queryPeriod } = monthInterval(period);

  // Household-scope inputs. Each slot's dtype is known from the schema, so we
  // pin the FactValue kind explicitly — that avoids bulk-if dtype mismatches
  // when the engine evaluates branches that read this input.
  const householdInputs: InputRecord[] = CO_SNAP_BASE.household_inputs.map((slot) => {
    const value = (household_overrides[slot.name] ?? slot.default) as FactScalar;
    return {
      name: legalInputId(slot.name),
      entity: "Household" as const,
      entity_id: "household:1",
      interval,
      value: fact(value, slot.dtype as "bool" | "integer" | "decimal" | "date"),
    };
  });

  // One Person per household member. Primary member carries the user-facing
  // overrides; additional members use schema defaults so the rules see a
  // fully-specified person regardless of count.
  const size = Math.max(1, Math.floor(resolved.household_size ?? 1));
  const personInputs: InputRecord[] = [];
  const relations = [];
  for (let i = 0; i < size; i++) {
    const personId = `person:${i + 1}`;
    relations.push({
      name: RELATION_MEMBER_OF_HOUSEHOLD,
      tuple: [personId, "household:1"] as [string, string],
      interval,
    });
    const overrides = i === 0 ? primary_member_overrides : {};
    personInputs.push(
      ...CO_SNAP_BASE.person_inputs.map((slot) => {
        const value = (overrides[slot.name] ?? slot.default) as FactScalar;
        return {
          name: legalInputId(slot.name),
          entity: "Person" as const,
          entity_id: personId,
          interval,
          value: fact(value, slot.dtype as "bool" | "integer" | "decimal" | "date"),
        };
      })
    );
  }

  // Query every public output the program exposes — surface picks what to render.
  const queries = Object.values(CO_SNAP_BASE.outputs_by_name);

  return {
    request: {
      mode,
      dataset: { inputs: [...householdInputs, ...personInputs], relations },
      queries: [{ entity_id: "household:1", period: queryPeriod, outputs: queries }],
    },
    resolved,
  };
}

/** Friendly outputs we surface to the chat layer. Order matters for citations. */
const SURFACE_OUTPUT_NAMES = [
  "snap_eligible",
  "snap_income_eligible",
  "snap_resource_eligible",
  "snap_work_requirement_eligible",
  "snap_residency_citizenship_eligible",
  "snap_regular_month_allotment",
  "snap_allotment",
  "snap_maximum_allotment",
  "gross_income",
  "snap_net_income",
  "snap_standard_utility_allowance",
  "snap_standard_deduction",
  "snap_earned_income_deduction",
  "excess_shelter_deduction",
  "shelter_costs",
] as const;
type SurfaceName = (typeof SURFACE_OUTPUT_NAMES)[number];

export interface CoSnapResult {
  period: string;
  household_size: number;
  outputs: Record<SurfaceName, number | "holds" | "not_holds">;
  applied_facts: CoSnapFacts;
  citations: Array<{ id: string; url: string }>;
}

interface OutputMeta {
  name: string;
  id: string;
  entity: string;
  semantics: string;
  dtype: string | null;
  unit: string | null;
  source: string | null;
}

const ALL_OUTPUTS = CO_SNAP_BASE.all_outputs as ReadonlyArray<OutputMeta>;

/** Tolerant resolver — accepts either a full legal_id or just the trailing
 *  `#name`/`name` portion. Returns undefined if no match (or ambiguous match).
 *
 *  Why: the model often guesses the file-path prefix wrong (e.g. it picks
 *  `us:policies/usda/snap/fy-2026-cola/deductions` for snap_earned_income_deduction
 *  when it actually lives at `us:statutes/7/2014/e/2`). The output NAME is
 *  unique across the program, so we let the suffix do the work. */
function resolveOutput(legal_id: string): OutputMeta | undefined {
  const exact = ALL_OUTPUTS.find((o) => o.id === legal_id);
  if (exact) return exact;
  const namePart = legal_id.includes("#") ? legal_id.split("#").pop()! : legal_id;
  const byName = ALL_OUTPUTS.filter((o) => o.name === namePart);
  if (byName.length === 1) return byName[0];
  return undefined;
}

/** Helpful error when resolution fails — includes close matches so the model
 *  can self-correct without going back to list_encoded_outputs. */
function buildLookupError(legal_id: string): string {
  const namePart = legal_id.includes("#") ? legal_id.split("#").pop()! : legal_id;
  const ambiguous = ALL_OUTPUTS.filter((o) => o.name === namePart);
  if (ambiguous.length > 1) {
    const ids = ambiguous.map((o) => o.id).join(", ");
    return `legal_id ${legal_id} is ambiguous — multiple outputs share the name "${namePart}". Use one of: ${ids}`;
  }
  // Look for substring matches on the local name to suggest alternatives.
  const needle = namePart.toLowerCase();
  const close = ALL_OUTPUTS.filter(
    (o) => o.name.toLowerCase().includes(needle) || needle.includes(o.name.toLowerCase())
  ).slice(0, 5);
  if (close.length > 0) {
    const ids = close.map((o) => o.id).join(", ");
    return `unknown legal_id: ${legal_id}. Did you mean one of: ${ids}?`;
  }
  return `unknown legal_id: ${legal_id} — call list_encoded_outputs(search="${namePart}") to find the right id.`;
}

/** Run the engine with arbitrary query outputs. Used by lookup_value to
 *  query any of the 168 derived outputs by legal ID, routed to the right
 *  entity_id based on the rule's entity scope. */
export async function lookupValue(
  legal_id: string,
  facts: CoSnapFacts = {}
): Promise<{
  legal_id: string;
  name: string;
  entity: "Household" | "Person" | "SnapUnit";
  dtype: string | null;
  unit: string | null;
  semantics: "scalar" | "judgment" | string;
  value: number | "holds" | "not_holds" | null;
  source: string | null;
  applied_facts: CoSnapFacts;
}> {
  const meta = resolveOutput(legal_id);
  if (!meta) {
    throw new Error(buildLookupError(legal_id));
  }
  // Use the resolved canonical id for the engine query — the model's input
  // may have had a wrong file prefix that we just fixed up.
  legal_id = meta.id;

  const { request, resolved } = buildRequest(facts, "explain");
  const period = request.queries[0].period;
  // Person rules query at person:1; everything else (Household, SnapUnit)
  // queries at household:1. SnapUnit rules in CO SNAP read household-level
  // inputs and the engine doesn't enforce entity-type identity, so reusing
  // the household entity_id avoids the "missing input" trap.
  const entity_id = meta.entity === "Person" ? "person:1" : "household:1";
  request.queries = [{ entity_id, period, outputs: [legal_id] }];

  const response = await runCompiled(ARTIFACT_SLUG, request);
  const out = response.results[0]?.outputs?.[legal_id];
  let value: number | "holds" | "not_holds" | null = null;
  if (out) {
    const r = readOutput(out);
    value = r.kind === "scalar" ? r.numeric ?? null : r.outcome ?? null;
  }
  return {
    legal_id,
    name: meta.name,
    entity: meta.entity as "Household" | "Person" | "SnapUnit",
    dtype: meta.dtype,
    unit: meta.unit,
    semantics: meta.semantics,
    value,
    source: meta.source,
    applied_facts: resolved,
  };
}

/** End-to-end: take user-facing facts → engine request → typed result.
 *  Defaults to "explain" because the CO SNAP composition uses count_related
 *  and date functions that aren't supported by the bulk fast path. */
export async function compute(
  facts: CoSnapFacts,
  mode: "fast" | "explain" = "explain"
): Promise<CoSnapResult> {
  const { request, resolved } = buildRequest(facts, mode);
  const response = await runCompiled(ARTIFACT_SLUG, request);
  return shapeResult(response, resolved);
}

function shapeResult(response: ExecutionResponse, resolved: CoSnapFacts): CoSnapResult {
  const out = response.results[0]?.outputs ?? {};
  const outputsByName = CO_SNAP_BASE.outputs_by_name as Record<string, string>;

  const surface: Partial<Record<SurfaceName, number | "holds" | "not_holds">> = {};
  for (const name of SURFACE_OUTPUT_NAMES) {
    const id = outputsByName[name];
    if (!id) continue;
    const v = out[id];
    if (!v) continue;
    const r = readOutput(v);
    surface[name] = r.kind === "scalar" ? r.numeric ?? 0 : r.outcome ?? "not_holds";
  }
  // Fill any gaps with safe defaults so the surface contract is total.
  for (const name of SURFACE_OUTPUT_NAMES) {
    if (surface[name] === undefined) {
      surface[name] = name.startsWith("snap_") && name.endsWith("_eligible") ? "not_holds" : 0;
    }
  }

  return {
    period: resolved.period!,
    household_size: resolved.household_size!,
    outputs: surface as Record<SurfaceName, number | "holds" | "not_holds">,
    applied_facts: resolved,
    citations: citationsFor(out),
  };
}

/** Each output id encodes its legal source. */
function citationsFor(outputs: Record<string, unknown>): Array<{ id: string; url: string }> {
  const seen = new Set<string>();
  const cites: Array<{ id: string; url: string }> = [];
  for (const id of Object.keys(outputs)) {
    const base = id.split("#")[0];
    if (!base.includes(":") || seen.has(base)) continue;
    seen.add(base);
    cites.push({ id: base, url: legalIdToUrl(base) });
  }
  return cites;
}

export function legalIdToUrl(id: string): string {
  const [jurisdiction, restPath] = id.split(":");
  if (!jurisdiction || !restPath) return "https://app.axiom-foundation.org/";
  const remap: Record<string, string> = {
    statutes: "statute",
    regulations: "regulation",
    policies: "policy",
  };
  const segments = restPath.split("/");
  if (segments[0] && remap[segments[0]]) segments[0] = remap[segments[0]];
  return `https://app.axiom-foundation.org/${jurisdiction}/${segments.join("/")}`;
}
