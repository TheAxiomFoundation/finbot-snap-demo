/**
 * AI SDK tool definitions — five generic, catalog-driven tools. The system
 * prompt (`prompts.ts`) instructs the model to take every dollar amount and
 * eligibility verdict from these tools; that is a prompt-level contract with
 * no runtime check (`bun run eval:llm` measures it).
 *
 * Unknown program slugs, input names, and output names come back as
 * structured errors with nearest-match suggestions instead of thrown
 * exceptions, so the model can self-correct in the next step.
 */
import { tool } from "ai";
import { z } from "zod";

import { getCatalog, getProgram, searchOutputs, type CatalogProgram } from "./catalog";
import { fetchCitation } from "./citations";
import { programDisclosures } from "./catalog-overlay";
import { describeProgramPayload } from "./describe";
import { legalIdToUrl } from "./legal-links";
import {
  UnknownInputError,
  UnknownOutputError,
  NotSettableInputError,
  NotMemberInputError,
  NoMemberEntityError,
  UnitFactUnsetError,
  UnknownRelationError,
  computeProgram,
  defaultPeriodFor,
  labelFor,
  memberCountSlotNames,
  nearestNames,
  resolveOutput,
  type RuleProvenance,
  type Stamps,
} from "./request-builder";

const FactsSchema = z
  .record(z.union([z.boolean(), z.number(), z.string()]))
  .describe(
    "Program input slots by exact slot name (see describe_program), e.g. {\"household_size\": 3, \"member_age\": 34}. Every slot not provided uses its documented default."
  );

const MembersSchema = z
  .array(
    z.object({
      facts: FactsSchema.optional(),
      relations: z
        .array(z.string())
        .optional()
        .describe(
          "Relation names linking this member to the primary entity (short names from describe_program, e.g. 'dependent_of_tax_unit'); unknown names are refused. Omit to link through every member relation."
        ),
    })
  )
  .describe(
    "One entry per household/tax-unit member. Member facts use member-entity slots (e.g. member_age). Top-level facts that name member-scope slots apply to EVERY listed member as a shared base (use for taxpayer-level facts like SSN-on-return); per-member facts override. Omit members to synthesize them from a recognized count input listed in describe_program. On a program with no member entity (describe_program member_entity: null), entries take no facts and only set its household-count input."
  );

const PeriodSchema = z
  .string()
  .regex(/^\d{4}(-\d{2})?$/)
  .optional()
  .describe(
    "Evaluation period, YYYY-MM or YYYY, subject to encoded formula and parameter coverage. Defaults to the current month (current year for annual programs) — only pass this when the user asks about a different time. A missing formula version returns a rule-coverage limitation instead of an amount or eligibility verdict."
  );

function programOr404(slug: string): CatalogProgram | { error: string; known_slugs: string[] } {
  const program = getProgram(slug);
  if (program) return program;
  return {
    error: `unknown program: ${slug}`,
    known_slugs: nearestNames(slug, getCatalog().programs.map((p) => p.slug), 8),
  };
}

function isErr(x: unknown): x is { error: string } {
  return typeof x === "object" && x !== null && "error" in x;
}

/** Convert builder errors into data the model can act on. */
function asToolError(err: unknown, program: CatalogProgram, requestedPeriod?: string) {
  // Both local and hosted adapters preserve this engine diagnostic. Keep the
  // missing rule visible as an encoding limitation, without shaping any value.
  const gap = err instanceof Error
    ? /derived `([^`]+)` has no formula version at (\d{4}-\d{2}-\d{2})/.exec(err.message)
    : null;
  if (gap) {
    const [, output, atDate] = gap;
    const period = requestedPeriod ?? defaultPeriodFor(program);
    const disclosure = `Axiom has no rule in force for ${period} for ${output}.`;
    return {
      error: disclosure,
      kind: "no_formula_version",
      program: program.slug,
      period,
      output,
      at_date: atDate,
      applied: { disclosures: [...programDisclosures(program), disclosure] },
      hint: "Disclose this rule-coverage limitation. Do not present a dollar amount or eligibility verdict, change the requested period, or retry with different eligibility facts.",
    };
  }
  if (err instanceof NotSettableInputError) {
    return {
      error: err.message,
      kind: err.kind,
      slot: err.slot,
      path: err.path,
      hint: "Remove this fact and disclose the encoding limitation. Do not retry by setting an eligibility gate or routing it through members[].facts.",
    };
  }
  if (err instanceof NotMemberInputError) {
    const counts = memberCountSlotNames(program);
    return {
      error: err.message,
      kind: err.kind,
      misplaced: err.misplaced,
      hint: err.memberEntity
        ? "These slots take one value for the whole unit, not one per member. Move each into the top-level facts and retry. If members gave different values for one slot, ask the user which applies instead of picking one."
        : counts.length > 0
          ? `This program has no member entity. Put every fact in the top-level facts and retry. members[] here only sets the household count (${counts.join(", ")}): keep one entry per member without facts, or set the count fact directly.`
          : "This program has no member entity. Put every fact in the top-level facts, drop members[], and retry. If the household size matters, set the program's own count fact from describe_program.",
    };
  }
  if (err instanceof NoMemberEntityError) {
    return {
      error: err.message,
      kind: err.kind,
      member_count: err.memberCount,
      ...(err.conflicts.length > 0 && { conflicts: err.conflicts }),
      hint: err.conflicts.length > 0
        ? "members[] and the count fact give two different household sizes. Retry with one: set the count fact to the number of members, or drop members[] if the count is deliberately different (e.g. household members outside the assistance unit). If the user's description gives two sizes, ask which applies."
        : "members[] cannot change this program's result. Drop members[] and put every fact in the top-level facts. If the household size matters, set the program's own count fact from describe_program (inputs_search \"count\" or \"size\") and retry.",
    };
  }
  if (err instanceof UnknownRelationError) {
    return {
      error: err.message,
      kind: err.kind,
      unknown: err.unknown,
      hint: err.known.length > 0
        ? `Use exact relation names from describe_program (${err.known.join(", ")}), or omit relations to link the member through every member relation (the usual case). Retry compute with corrected names.`
        : "This program has no member relations. Drop relations from every members[] entry and retry.",
    };
  }
  if (err instanceof UnitFactUnsetError) {
    return {
      error: err.message,
      kind: err.kind,
      unset: err.unset,
      hint: "Each slot listed is read on the unit as well as on each member, and a members[] value reaches only that member. Put the unit's value in the top-level facts and retry. Keep a member entry only for a member whose own value differs (e.g. a dependent's own return). If members gave different values, ask the user which one applies to the unit instead of picking one.",
    };
  }
  if (err instanceof UnknownInputError) {
    return {
      error: err.message,
      suggestions: err.suggestions,
      hint: "Use exact input slot names from describe_program (inputs_search narrows the list). Retry compute with a corrected fact name.",
    };
  }
  if (err instanceof UnknownOutputError) {
    return {
      error: err.message,
      suggestions: err.suggestions,
      hint: "Use exact output names from describe_program or list_programs search.",
    };
  }
  throw err;
}

/** Engine (and other unexpected) failures as data, never as a thrown error:
 *  a throw inside a tool executor ends the chat stream, and the user gets an
 *  empty reply instead of an explanation or a retry. */
function engineFailure(err: unknown): { error: string; hint: string } {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 600);
  const missing = /missing input `([^`]+)`/.exec(message)?.[1];
  return {
    error: `calculation failed: ${message}`,
    hint: missing
      ? `The rules engine needed input "${missing}", which this request did not resolve. If describe_program lists it as an input slot and the user's facts determine it, retry once with it set as a fact. Otherwise tell the user this calculation could not be completed — do NOT state a figure for it from memory.`
      : "The rules engine could not finish this calculation. If the error points at a fact you passed, retry once with a corrected value. Otherwise tell the user this calculation could not be completed — do NOT state a figure for it from memory.",
  };
}

/** Wrap a tool executor so every object result carries `_ms` (execution time)
 *  and the server logs a timing line. This is how we attribute latency between
 *  engine work (fast) and LLM round-trips (slow). */
function timed<A, R>(name: string, execute: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return async (args: A) => {
    const started = Date.now();
    const result = await execute(args);
    const ms = Date.now() - started;
    const bytes = JSON.stringify(result)?.length ?? 0;
    console.log(`[finbot:timing] tool ${name} ${ms}ms ${bytes}B`);
    if (isErr(result)) {
      console.warn(`[finbot:tool-error] ${name} args=${JSON.stringify(args)} result=${JSON.stringify(result)}`);
    }
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return { ...(result as object), _ms: ms } as R;
    }
    return result;
  };
}

/** Provenance for one compute/lookup, handed to `onProvenance` instead of the
 *  model — the trace-derived rule paths and stamps are a UI/audit concern
 *  (20–50 KB of derivation per call), not something the model should have to
 *  carry through its context window. */
export interface ProvenanceAnnotation {
  type: "provenance";
  tool: "compute" | "lookup_value";
  program: string;
  stamps: Stamps;
  provenance: Record<string, RuleProvenance>;
}

/** Build the tool set. `onProvenance`, when given, is called once per
 *  compute/lookup_value with the trace-derived rule paths and stamps that
 *  call produced — the model never sees them (see `ProvenanceAnnotation`);
 *  route.ts forwards them to the client as stream annotations instead. */
export function createTools(onProvenance?: (event: ProvenanceAnnotation) => void) {
  return {
    list_programs: tool({
      description:
        "Search encoded output names (thresholds, deductions, credits) across all encoded programs via `search`. The system-prompt coverage digest already lists every program with its primary output — do NOT call this to confirm a program exists or to restate coverage; call it only when you genuinely need the output-name search.",
      parameters: z.object({
        jurisdiction: z
          .string()
          .optional()
          .describe("Optional filter, e.g. 'us-co' for Colorado or 'us' for federal."),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive multi-word search across all encoded output names in every program. Numbers also match the rule's legal citation ('exemption amount 151' finds 26 USC 151 rules); years and filler words are ignored. If no output matches every word, the closest matches come back with `unmatched_terms`."),
      }),
      execute: timed("list_programs", async ({ jurisdiction, search }) => {
        const catalog = getCatalog();
        const programs = catalog.programs
          .filter((p) => !jurisdiction || p.jurisdiction === jurisdiction)
          .map((p) => ({
            slug: p.slug,
            jurisdiction: p.jurisdiction,
            display_name: p.display_name,
            default_period: defaultPeriodFor(p),
            primary_output: p.primary_output,
            published_outputs: p.certified_outputs,
            acknowledged_incomplete: p.acknowledged_incomplete,
          }));
        const matches = search ? searchOutputs(search, { jurisdiction }) : null;
        return {
          release: catalog.release_tag,
          programs,
          total_programs: catalog.programs.length,
          ...(matches !== null && {
            search_matches: matches.map((m) => ({
              program: m.program,
              name: m.output.name,
              legal_id: m.output.id,
              entity: m.output.entity,
              semantics: m.output.semantics,
              unit: m.output.unit,
              published_output: m.output.certified,
              ...(m.unmatched && { unmatched_terms: m.unmatched }),
            })),
          }),
        };
      }),
    }),

    describe_program: tool({
      description:
        "Describe one program's computable surface: its entities, member relations, published outputs, and input slots (name:dtype, defaults applied when omitted). Call this ONCE, without inputs_search, before the first compute for a program — most programs fit in one response. Only call again with `inputs_search` if the response reports omitted slots and you need one it didn't show.",
      parameters: z.object({
        program: z.string().describe("Program slug from list_programs, e.g. 'us-co-snap'."),
        inputs_search: z
          .string()
          .optional()
          .describe("Case-insensitive filter over input slot names, e.g. 'income' or 'shelter'."),
      }),
      execute: timed("describe_program", async ({ program: slug, inputs_search }) => {
        const program = programOr404(slug);
        if (isErr(program)) return program;
        return describeProgramPayload(program, inputs_search);
      }),
    }),

    compute: tool({
      description:
        "Run an encoded program against a scenario and return its primary output plus all published outputs, with citations. Facts are input-slot overrides on top of documented defaults; everything else stays defaulted. If the result flags acknowledged_incomplete outputs, tell the user that part of the rule chain is not fully encoded yet.",
      parameters: z.object({
        program: z.string().describe("Program slug from list_programs, e.g. 'us-ny-snap'."),
        period: PeriodSchema,
        facts: FactsSchema.optional(),
        members: MembersSchema.optional(),
        extra_outputs: z
          .array(z.string())
          .optional()
          .describe("Additional encoded output names to include in the same run (e.g. intermediate deductions for a breakdown)."),
      }),
      execute: timed("compute", async ({ program: slug, period, facts, members, extra_outputs }) => {
        const program = programOr404(slug);
        if (isErr(program)) return program;
        try {
          // An unknown extra_outputs name must not fail the whole compute — the
          // main calculation is still valid, and failing it costs the model a
          // full retry round-trip (the dominant latency flake before this).
          // Skip unknown names and report them with suggestions instead.
          const extraErrors: Array<{ name: string; error: string; suggestions?: string[] }> = [];
          const validExtras = extra_outputs?.filter((name) => {
            try {
              resolveOutput(program, name);
              return true;
            } catch (err) {
              if (err instanceof UnknownOutputError) {
                extraErrors.push({ name, error: err.message, suggestions: err.suggestions });
                return false;
              }
              throw err;
            }
          });
          const full = await computeProgram({
            program,
            period,
            facts,
            members,
            extraOutputs: validExtras,
          });
          const { provenance, stamps, ...result } = full;
          onProvenance?.({ type: "provenance", tool: "compute", program: program.slug, stamps, provenance });
          return extraErrors.length === 0
            ? result
            : {
                ...result,
                extra_outputs_errors: extraErrors,
                extra_outputs_note:
                  "Unknown extra_outputs names were SKIPPED (suggestions listed) — every other output above was computed normally. Re-request a skipped output (once, via a suggested name) only if it is essential to the user's question.",
              };
        } catch (err) {
          try {
            return asToolError(err, program, period);
          } catch {
            console.error("[finbot] compute failed:", err, "program:", slug, "facts:", facts);
            return engineFailure(err);
          }
        }
      }),
    }),

    lookup_value: tool({
      description:
        "Read a single encoded output — a threshold, limit, deduction amount, or any intermediate value — by name. Routes the query to the right entity automatically. Facts still apply: size-indexed values (income limits, maximum allotments) need the relevant count input from describe_program. A value read through a count of qualifying members (a credit maximum indexed by qualifying children) needs members[], and its member_checks show whether each member counted.",
      parameters: z.object({
        program: z.string().describe("Program slug from list_programs."),
        output: z.string().describe("Output name (or legal id) exactly as returned by describe_program or list_programs search."),
        period: PeriodSchema,
        facts: FactsSchema.optional(),
        members: MembersSchema.optional(),
      }),
      execute: timed("lookup_value", async ({ program: slug, output, period, facts, members }) => {
        const program = programOr404(slug);
        if (isErr(program)) return program;
        try {
          const meta = resolveOutput(program, output);
          const shaped = await computeProgram({
            program,
            period,
            facts,
            members,
            outputsOverride: [meta.name],
          });
          onProvenance?.({
            type: "provenance",
            tool: "lookup_value",
            program: program.slug,
            stamps: shaped.stamps,
            provenance: shaped.provenance,
          });
          const value = shaped.outputs.find((o) => o.name === meta.name);
          // A failed judgment names only what its inputs don't meet, as in
          // compute; one that holds lists the rule's whole requirement.
          const requires = value?.value === "not_holds" ? value.requires : meta.requires;
          return {
            program: program.slug,
            name: meta.name,
            label: labelFor(meta.name),
            legal_id: meta.id,
            entity: meta.entity,
            semantics: meta.semantics,
            unit: meta.unit,
            value: value?.value ?? null,
            // With a members list: the gates this value counts members
            // through, per member, read like compute's.
            ...(shaped.member_checks && { member_checks: shaped.member_checks }),
            ...(meta.semantics === "judgment" && (meta.requires || value?.requires_any) && {
              ...(requires && { requires }),
              ...(value?.requires_any && { requires_any: value.requires_any }),
              ...(meta.requires_partial && { requires_partial: true }),
            }),
            published_output: meta.certified,
            acknowledged_incomplete: meta.acknowledged_incomplete,
            incomplete_note: meta.acknowledged_incomplete
              ? `Flagged in the program spec as not fully encoded: ${meta.name}.`
              : null,
            source: meta.source,
            url: meta.id ? legalIdToUrl(meta.id) : null,
            applied: shaped.applied,
          };
        } catch (err) {
          try {
            return asToolError(err, program, period);
          } catch {
            console.error("[finbot] lookup_value failed:", err, "program:", slug, "output:", output);
            return engineFailure(err);
          }
        }
      }),
    }),

    fetch_citation: tool({
      description:
        "Pull the legal text behind a legal id returned by compute or lookup_value, e.g. 'us:statutes/7/2017/a' or 'us-co:regulations/10-ccr-2506-1/4.207.3'. Use when the user asks for the source of a number or rule.",
      parameters: z.object({
        legal_id: z
          .string()
          .describe("Legal id from a compute/lookup result or citation list. Strip any '#rule_name' suffix."),
      }),
      execute: timed("fetch_citation", async ({ legal_id }) => {
        try {
          return await fetchCitation(legal_id);
        } catch (err) {
          console.error("[finbot] fetch_citation failed:", err);
          throw err;
        }
      }),
    }),
  };
}

/** The tool set without a provenance sink, for scripts and tests. */
export const tools = createTools();
