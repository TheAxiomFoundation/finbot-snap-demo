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

/** Compact one-token slot description for describe_program:
 *  `name:dtype`, `=default` when non-zero/false, `{1=joint,2=separate}` for
 *  enum codes (labels reduced to their distinctive tails), `(eq 12)` for
 *  equality-gate values, trailing `*` for branch-selector flags. */
function describeSlot(s: CatalogProgram["inputs"][string][number]): string {
  let out = `${s.name}:${s.dtype}`;
  if (s.enum) {
    const labels = Object.values(s.enum);
    const prefix = commonPrefix(labels.filter(Boolean));
    const entries = Object.entries(s.enum)
      .map(([value, label]) => `${value}${label ? `=${label.slice(prefix.length) || label}` : ""}`)
      .join(",");
    out += `{${entries}}`;
  }
  if (!(s.default === false || s.default === 0 || s.default === "")) out += `=${s.default}`;
  if (s.eq_hints?.length) out += `(eq ${s.eq_hints.join("|")})`;
  if (s.variant_switch) out += "*";
  if (s.aux) out = "~" + out;
  return out;
}

function commonPrefix(strings: string[]): string {
  if (strings.length < 2) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

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

      const INPUT_CAP = 120;
      const filter = inputs_search?.toLowerCase();
      const inputs: Record<string, { slots: string[]; omitted: number; aux_hidden?: number }> = {};
      const defaultOverrides: Record<string, boolean | number | string> = {};
      for (const [entity, slots] of Object.entries(program.inputs)) {
        const matching = slots.filter((s) => !filter || s.name.toLowerCase().includes(filter));
        // Without a search filter, show only slots on the certified-output
        // path — the auxiliary majority can't move the headline and would
        // drown the ones that do (and bloat every later model step).
        const relevant = filter ? matching : matching.filter((s) => !s.aux);
        const shown = relevant.slice(0, INPUT_CAP);
        inputs[entity] = {
          slots: shown.map(describeSlot),
          omitted: relevant.length - shown.length,
          ...(filter ? {} : { aux_hidden: matching.length - relevant.length }),
        };
        for (const s of slots) {
          if (s.default_source === "overlay") defaultOverrides[s.name] = s.default;
        }
      }
      const shortName = (name: string) => name.split("#").pop()!.replace(/^relation\./, "");
      return {
        slug: program.slug,
        display_name: program.display_name,
        description: program.description,
        default_period: defaultPeriodFor(program),
        primary_entity: program.primary_entity,
        member_entity: program.member_entity,
        relations: program.relations
          .filter((r) => r.used)
          .map((r) => ({ name: shortName(r.name), related_entity: r.related_entity })),
        primary_output: program.primary_output,
        certified_outputs: program.certified_outputs,
        acknowledged_incomplete: program.acknowledged_incomplete,
        total_outputs: program.outputs.length,
        inputs,
        ...(Object.keys(defaultOverrides).length > 0 && {
          default_overrides: defaultOverrides,
          default_overrides_note:
            "Curated defaults for law-variant/administrative inputs (already applied; override only if the user's situation differs).",
        }),
        slot_legend:
          "{1=a,2=b} enum codes (use ONLY listed codes; unlisted values fall through to the default branch) · (eq N) a value some rules require exactly — set it when ordinarily true and disclose · trailing * = branch selector that flips which rules apply, set deliberately · leading ~ = auxiliary slot NOT on the certified-output path: setting it cannot change the headline, prefer the non-~ sibling",
        notes: [
          "Facts you don't provide default to false/0 — state the defaults you rely on.",
          "aux_hidden counts auxiliary slots not on the certified-output path (they can't change the headline); pass inputs_search to see them.",
          program.member_entity
            ? `Members: pass members[] (facts use ${program.member_entity}-scope slots), or a *_size fact to synthesize identical members.`
            : "This program has no member entity; only top-level facts apply.",
          "Any of the total_outputs encoded outputs can be read with lookup_value or compute extra_outputs.",
        ],
      };
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
        return await computeProgram({
          program,
          period,
          facts,
          members,
          extraOutputs: extra_outputs,
        });
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
