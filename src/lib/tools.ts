/**
 * AI SDK tool definitions — five generic, catalog-driven tools. The model
 * only emits dollar amounts and eligibility verdicts that flow through these
 * tools; see `prompts.ts` for the system contract that enforces it.
 *
 * Unknown program slugs, input names, and output names come back as
 * structured errors with nearest-match suggestions instead of thrown
 * exceptions, so the model can self-correct in the next step.
 */
import { tool } from "ai";
import { z } from "zod";

import { getCatalog, getProgram, searchOutputs, type CatalogProgram } from "./catalog";
import { fetchCitation } from "./citations";
import { describeProgramPayload } from "./describe";
import { legalIdToUrl } from "./legal-links";
import {
  UnknownInputError,
  UnknownOutputError,
  buildRequest,
  computeProgram,
  defaultPeriodFor,
  labelFor,
  nearestNames,
  resolveOutput,
  shapeResult,
} from "./request-builder";
import { runCompiled } from "./engine";

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
          "Relation names linking this member to the primary entity (short names from describe_program, e.g. 'dependent_of_tax_unit'). Omit to link through every member relation."
        ),
    })
  )
  .describe(
    "One entry per household/tax-unit member. Member facts use member-entity slots (e.g. member_age). Top-level facts that name member-scope slots apply to EVERY listed member as a shared base (use for taxpayer-level facts like SSN-on-return); per-member facts override. Omit members to synthesize them from a *_size fact."
  );

const PeriodSchema = z
  .string()
  .regex(/^\d{4}(-\d{2})?$/)
  .optional()
  .describe(
    "Evaluation period, YYYY-MM or YYYY. Defaults to the current month (current year for annual programs) — only pass this when the user asks about a different time."
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
function asToolError(err: unknown): { error: string; suggestions?: string[]; hint?: string } {
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

export const tools = {
  list_programs: tool({
    description:
      "Search encoded output names (thresholds, deductions, credits) across all certified programs via `search`. The system-prompt coverage digest already lists every program with its primary output — do NOT call this to confirm a program exists or to restate coverage; call it only when you genuinely need the output-name search.",
    parameters: z.object({
      jurisdiction: z
        .string()
        .optional()
        .describe("Optional filter, e.g. 'us-co' for Colorado or 'us' for federal."),
      search: z
        .string()
        .optional()
        .describe("Case-insensitive multi-word search across all encoded output names in every program."),
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
          certified_outputs: p.certified_outputs,
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
            certified: m.output.certified,
          })),
        }),
      };
    }),
  }),

  describe_program: tool({
    description:
      "Describe one program's computable surface: its entities, member relations, certified outputs, and input slots (name:dtype, defaults applied when omitted). Call this ONCE, without inputs_search, before the first compute for a program — most programs fit in one response. Only call again with `inputs_search` if the response reports omitted slots and you need one it didn't show.",
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
      "Run a certified program against a scenario and return its primary output plus all certified outputs, with citations. Facts are input-slot overrides on top of documented defaults; everything else stays defaulted. If the result flags acknowledged_incomplete outputs, tell the user that part of the rule chain is not fully encoded yet.",
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
        const result = await computeProgram({
          program,
          period,
          facts,
          members,
          extraOutputs: validExtras,
        });
        return extraErrors.length === 0
          ? result
          : {
              ...result,
              extra_outputs_errors: extraErrors,
              extra_outputs_note:
                "Unknown extra_outputs names were SKIPPED (suggestions listed) — every other output above is complete and correct. Re-request a skipped output (once, via a suggested name) only if it is essential to the user's question.",
            };
      } catch (err) {
        try {
          return asToolError(err);
        } catch {
          console.error("[finbot] compute failed:", err, "program:", slug, "facts:", facts);
          throw err;
        }
      }
    }),
  }),

  lookup_value: tool({
    description:
      "Read a single encoded output — a threshold, limit, deduction amount, or any intermediate value — by name. Routes the query to the right entity automatically. Facts still apply: size-indexed values (income limits, maximum allotments) need the relevant *_size fact.",
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
        const built = buildRequest({
          program,
          period,
          facts,
          members,
          outputsOverride: [meta.name],
        });
        const response = await runCompiled(program.slug, built.request);
        const shaped = shapeResult(program, built, response);
        const value = shaped.outputs.find((o) => o.name === meta.name);
        return {
          program: program.slug,
          name: meta.name,
          label: labelFor(meta.name),
          legal_id: meta.id,
          entity: meta.entity,
          semantics: meta.semantics,
          unit: meta.unit,
          value: value?.value ?? null,
          ...(meta.semantics === "judgment" && meta.requires && {
            requires: meta.requires,
            ...(meta.requires_partial && { requires_partial: true }),
          }),
          certified: meta.certified,
          acknowledged_incomplete: meta.acknowledged_incomplete,
          incomplete_note: meta.acknowledged_incomplete
            ? `Output ${meta.name} is flagged acknowledged_incomplete by the rulespec authors (parts of the rule chain are known to be unfinished). Flag this to the user.`
            : null,
          source: meta.source,
          url: meta.id ? legalIdToUrl(meta.id) : null,
          applied: shaped.applied,
        };
      } catch (err) {
        try {
          return asToolError(err);
        } catch {
          console.error("[finbot] lookup_value failed:", err, "program:", slug, "output:", output);
          throw err;
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
