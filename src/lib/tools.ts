/**
 * AI SDK tool definitions. The model only emits dollar amounts and eligibility
 * verdicts that flow through these tools — see `prompts.ts` for the system
 * contract that enforces it.
 */
import { tool } from "ai";
import { z } from "zod";

import { CATALOG, type Country, programsForCountry } from "./catalog";
import { fetchCitation } from "./citations";
import { compute, lookupValue, type CoSnapFacts } from "./programs/co-snap";
import { CO_SNAP_BASE } from "./programs/co-snap-base";
import {
  computeDashboardSnap,
  isDashboardSnapLegalId,
  lookupDashboardSnapValue,
} from "./programs/dashboard-snap";
import { rankNextQuestions } from "./ranking";
import {
  computeUkPersonalAllowance,
  type UkPersonalAllowanceFacts,
} from "./programs/uk-personal-allowance";
import { UK_PERSONAL_ALLOWANCE_BASE } from "./programs/uk-personal-allowance-base";

const CoSnapFactsSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional()
    .describe("Calendar month, format YYYY-MM. Defaults to 2026-01."),
  household_size: z.number().int().min(1).max(20).optional()
    .describe("Total people in the SNAP household."),
  monthly_earnings_per_adult: z.number().min(0).optional()
    .describe("Combined monthly wages for the household, in dollars."),
  monthly_unearned_income: z.number().min(0).optional()
    .describe("Monthly unearned income (UI, SS, child support) in dollars."),
  monthly_shelter_costs: z.number().min(0).optional()
    .describe("Monthly out-of-pocket rent/mortgage in dollars."),
  pays_separate_heating_or_cooling: z.boolean().optional()
    .describe("Whether the household pays heating or cooling separate from rent. Drives utility allowance type."),
  liquid_resources: z.number().min(0).optional()
    .describe("Cash plus money in checking/savings accounts."),
  oldest_member_age: z.number().int().min(0).max(120).optional()
    .describe("Age of the primary applicant; affects work-requirement and SUA logic."),
  any_member_elderly_or_disabled: z.boolean().optional()
    .describe("Whether any household member is age 60+ or receiving disability benefits."),
  primary_member_is_us_citizen: z.boolean().optional(),
});

const UkPersonalAllowanceFactsSchema = z.object({
  tax_year_start: z.number().int().min(2000).max(2050).optional()
    .describe("Calendar year the UK tax year starts (e.g. 2025 for tax year 2025-26). Defaults to 2025."),
  adjusted_net_income: z.number().min(0).optional()
    .describe("Adjusted net income for the tax year, in GBP. Drives the £100k allowance taper."),
  individual_makes_claim: z.boolean().optional()
    .describe("Whether the individual has claimed the allowance under s.35(1). Defaults true."),
  meets_section_56_requirements: z.boolean().optional()
    .describe("Whether the individual meets s.56 (UK residence / qualifying status). Defaults true."),
});

const usTools = {
  list_encoded_outputs: tool({
    description:
      "List benefit and tax programs that axiom-rules-engine has actually encoded for the United States: Colorado, California, and New York SNAP. Call this BEFORE answering any program question. Pass `search` to find a legal_id you can then read with lookup_value when available.",
    parameters: z.object({
      jurisdiction: z
        .string()
        .optional()
        .describe("Optional filter, e.g. 'us-co' or 'us'."),
      search: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring search across encoded output names."),
    }),
    execute: async ({ jurisdiction, search }) => {
      const programs = programsForCountry("us").filter((p) => !jurisdiction || p.jurisdiction === jurisdiction);
      const coOutputs = CO_SNAP_BASE.all_outputs as ReadonlyArray<{
        name: string;
        id: string;
        entity: string;
        semantics: string;
        unit?: string | null;
      }>;
      const catalogOutputs = CATALOG.filter((p) => p.country === "us").flatMap((program) =>
        program.outputs.map((output) => ({
          name: output.legal_id.split("#").pop() ?? output.label,
          id: output.legal_id,
          entity: "Household",
          semantics: output.kind === "judgment" ? "judgment" : "scalar",
          unit: output.kind === "scalar" ? "USD" : null,
        }))
      );
      const all = dedupeOutputs([...coOutputs, ...catalogOutputs]);
      // Normalize: lowercase, replace non-alphanumeric runs with a single
      // space, so "income limit", "income_limit", and "INCOME-LIMIT" all
      // match `snap_gross_income_limit_130_percent_fpl_48_states_dc`.
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const matches = search
        ? (() => {
            const needle = normalize(search);
            // Tokenize both sides; require all needle tokens to appear in the
            // output name (in any order) so multi-word searches still match.
            const tokens = needle.split(" ").filter(Boolean);
            return all.filter((o) => {
              const hay = " " + normalize(o.name) + " ";
              return tokens.every((t) => hay.includes(t));
            });
          })()
        : null;
      return {
        programs: programs.map((p) => ({
          slug: p.slug,
          jurisdiction: p.jurisdiction,
          display_name: p.display_name,
          scope: p.scope,
          rulespec_path: p.rulespec_path,
          outputs: p.outputs,
          primary_output: p.primary_output,
        })),
        catalog_size: CATALOG.length,
        encoded_outputs_total: all.length,
        co_compiled_outputs_total: coOutputs.length,
        ...(matches !== null && {
          search_matches: matches.slice(0, 24).map((o) => ({
            legal_id: o.id,
            name: o.name,
            entity: o.entity,
            semantics: o.semantics,
            unit: o.unit ?? null,
          })),
          truncated: matches.length > 24,
        }),
      };
    },
  }),

  compute_co_snap: tool({
    description:
      `Run the Colorado SNAP FY-2026 RuleSpec against a household and return its monthly benefit and eligibility breakdown.

      HEADLINE FIELD. The user-facing dollar amount is \`outputs.snap_regular_month_allotment\`. Don't lead with \`snap_maximum_allotment\` (size-based ceiling, larger but not what's paid) or \`snap_allotment\` (CO post-proration final, often equal to regular but distinct).

      ELIGIBILITY FIELDS. If \`outputs.snap_eligible\` is "not_holds", these sub-judgments locate which test failed:
      - \`snap_resource_eligible\` (countable assets vs. asset limit)
      - \`snap_income_eligible\` (gross / net income tests)
      - \`snap_work_requirement_eligible\` (general / ABAWD work requirements)
      - \`snap_residency_citizenship_eligible\` (state residency + at least one citizen-or-eligible-alien member)
      Name the failing sub-judgment in your reply.

      FACT INFERENCES the user expects you to make:
      - "X hrs/week at $Y/hr" → monthly_earnings_per_adult ≈ X × Y × 4.33. Show the math when you state the assumption.
      - "Single mom of two kids" / "family of four" → household_size = total people in the SNAP household.
      - Default oldest_member_age = 30 for working-age users; primary_member_is_us_citizen = true. State both as inferred assumptions.
      - Don't pad facts the user didn't volunteer (assets, unearned income, separate utilities, shelter cost). Leaving them undefined makes them show up in rank_next_question's variance ranking, which is the right place for them.`,
    parameters: CoSnapFactsSchema,
    execute: async (facts) => {
      try {
        return await compute(facts as CoSnapFacts);
      } catch (err) {
        console.error("[finbot] compute_co_snap failed:", err, "facts:", facts);
        throw err;
      }
    },
  }),

  compute_ca_snap: tool({
    description:
      `Run the California SNAP FY-2026 composed RuleSpec against a household and return its monthly benefit and eligibility breakdown.

      HEADLINE FIELD. The user-facing dollar amount is \`outputs.snap_benefit\`. The result also aliases this to \`outputs.snap_regular_month_allotment\` so shared UI cards can render it, but your text should call it the SNAP benefit.

      ELIGIBILITY FIELDS. If \`outputs.snap_eligible\` is "not_holds", inspect \`snap_resource_eligible\` and \`snap_income_eligible\` to identify the failing test when present.

      FACT INFERENCES the user expects you to make:
      - "X hrs/week at $Y/hr" → monthly_earnings_per_adult ≈ X × Y × 4.33. Show the math when you state the assumption.
      - "Single mom of two kids" / "family of four" → household_size = total people in the SNAP household.
      - Default oldest_member_age = 30 and primary_member_is_us_citizen = true when the user does not say otherwise. State both as inferred assumptions.
      - Leave assets, unearned income, shelter cost, and utility facts undefined unless the user gives them.`,
    parameters: CoSnapFactsSchema,
    execute: async (facts) => {
      try {
        return await computeDashboardSnap("ca", facts as CoSnapFacts);
      } catch (err) {
        console.error("[finbot] compute_ca_snap failed:", err, "facts:", facts);
        throw err;
      }
    },
  }),

  compute_ny_snap: tool({
    description:
      `Run the New York SNAP FY-2026 composed RuleSpec against a household and return its monthly benefit and eligibility breakdown.

      HEADLINE FIELD. The user-facing dollar amount is \`outputs.snap_benefit\`. The result also aliases this to \`outputs.snap_regular_month_allotment\` so shared UI cards can render it, but your text should call it the SNAP benefit.

      ELIGIBILITY FIELDS. If \`outputs.snap_eligible\` is "not_holds", inspect \`snap_resource_eligible\` and \`snap_income_eligible\` to identify the failing test when present.

      FACT INFERENCES the user expects you to make:
      - "X hrs/week at $Y/hr" → monthly_earnings_per_adult ≈ X × Y × 4.33. Show the math when you state the assumption.
      - "Single mom of two kids" / "family of four" → household_size = total people in the SNAP household.
      - Default oldest_member_age = 30 and primary_member_is_us_citizen = true when the user does not say otherwise. State both as inferred assumptions.
      - Leave assets, unearned income, shelter cost, and utility facts undefined unless the user gives them.`,
    parameters: CoSnapFactsSchema,
    execute: async (facts) => {
      try {
        return await computeDashboardSnap("ny", facts as CoSnapFacts);
      } catch (err) {
        console.error("[finbot] compute_ny_snap failed:", err, "facts:", facts);
        throw err;
      }
    },
  }),

  rank_next_question: tool({
    description:
      "Colorado SNAP only: rank the next-best question to ask the user, by how much it would change the SNAP allotment. Returns each candidate's variance in dollars. Use this with compute_co_snap when the user has given partial Colorado facts and you want to ask only the highest-impact follow-up.",
    parameters: CoSnapFactsSchema,
    execute: async (facts) => {
      try {
        const ranked = await rankNextQuestions(facts as CoSnapFacts);
        return { ranked };
      } catch (err) {
        console.error("[finbot] rank_next_question failed:", err);
        throw err;
      }
    },
  }),

  lookup_value: tool({
    description:
      "Read an encoded output by its legal_id (e.g. 'us:policies/usda/snap/fy-2026-cola/income-eligibility-standards#snap_gross_income_limit_130_percent_fpl_48_states_dc'). Use this to answer questions about thresholds, limits, deduction amounts, or other parameters that compute_* doesn't surface. First call list_encoded_outputs with a `search` term to find the right legal_id. The household facts are still applied — for size-dependent values like income limits, pass at least household_size.",
    parameters: z.object({
      legal_id: z.string().describe("Full legal_id with the '#name' suffix, exactly as returned by list_encoded_outputs."),
      facts: CoSnapFactsSchema.optional().describe("Household facts to apply. household_size matters for table-indexed values like income limits."),
    }),
    execute: async ({ legal_id, facts }) => {
      try {
        if (isDashboardSnapLegalId(legal_id)) {
          return await lookupDashboardSnapValue(legal_id, (facts ?? {}) as CoSnapFacts);
        }
        return await lookupValue(legal_id, (facts ?? {}) as CoSnapFacts);
      } catch (err) {
        console.error("[finbot] lookup_value failed:", err, "legal_id:", legal_id);
        throw err;
      }
    },
  }),

  fetch_citation: tool({
    description:
      "Pull the legal text behind an axiom-rules-engine legal ID, e.g. 'us:statutes/7/2017/a' or 'us-co:regulations/10-ccr-2506-1/4.207.3'. Use this when the user asks for the source of a number or rule.",
    parameters: z.object({
      legal_id: z
        .string()
        .describe("Legal ID returned by compute_co_snap or list_encoded_outputs. Strip any '#rule_name' suffix."),
    }),
    execute: async ({ legal_id }) => {
      try {
        return await fetchCitation(legal_id);
      } catch (err) {
        console.error("[finbot] fetch_citation failed:", err);
        throw err;
      }
    },
  }),
};

const ukTools = {
  list_encoded_outputs: tool({
    description:
      "List benefit and tax programs that axiom-rules-engine has actually encoded for the United Kingdom. Currently: UK personal allowance under Income Tax Act 2007 s.35 (with the £100k taper). Call this BEFORE answering any program question.",
    parameters: z.object({
      search: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring search across encoded output names."),
    }),
    execute: async ({ search }) => {
      const programs = programsForCountry("uk");
      const ukOutputs = UK_PERSONAL_ALLOWANCE_BASE.all_outputs as ReadonlyArray<{
        name: string;
        id: string;
        entity: string;
        semantics: string;
        unit?: string | null;
      }>;
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const matches = search
        ? (() => {
            const needle = normalize(search);
            const tokens = needle.split(" ").filter(Boolean);
            return ukOutputs.filter((o) => {
              const hay = " " + normalize(o.name) + " ";
              return tokens.every((t) => hay.includes(t));
            });
          })()
        : null;
      return {
        programs: programs.map((p) => ({
          slug: p.slug,
          jurisdiction: p.jurisdiction,
          display_name: p.display_name,
          scope: p.scope,
          rulespec_path: p.rulespec_path,
          outputs: p.outputs,
          primary_output: p.primary_output,
        })),
        catalog_size: programs.length,
        encoded_outputs_total: ukOutputs.length,
        ...(matches !== null && {
          search_matches: matches.slice(0, 24).map((o) => ({
            legal_id: o.id,
            name: o.name,
            entity: o.entity,
            semantics: o.semantics,
            unit: o.unit ?? null,
          })),
          truncated: matches.length > 24,
        }),
      };
    },
  }),

  compute_uk_personal_allowance: tool({
    description:
      `Compute the UK personal income tax allowance under Income Tax Act 2007 s.35, including the £100,000 adjusted-net-income taper.

      HEADLINE FIELD. The user-facing pound amount is \`personal_allowance\` (returned in £).

      MECHANICS THE TAPER ENCODES:
      - Base allowance: £12,570 for an individual who claims and meets s.56 requirements.
      - For adjusted net income above £100,000, the allowance is reduced by £1 for every £2 over (s.35(2)). Result is rounded up to the nearest £1 (s.35(3)).
      - At adjusted net income ≥ £125,140, the allowance fully tapers to £0.

      FACT INFERENCES the user expects you to make:
      - Default tax_year_start = 2025 (i.e. tax year 2025-26).
      - Default individual_makes_claim = true and meets_section_56_requirements = true. State both as inferred assumptions.
      - "Earning £X" → adjusted_net_income = X unless the user mentions pension contributions or charitable giving that would adjust it. Show the inference.`,
    parameters: UkPersonalAllowanceFactsSchema,
    execute: async (facts) => {
      try {
        return await computeUkPersonalAllowance(facts as UkPersonalAllowanceFacts);
      } catch (err) {
        console.error("[finbot] compute_uk_personal_allowance failed:", err, "facts:", facts);
        throw err;
      }
    },
  }),

  fetch_citation: tool({
    description:
      "Pull the legal text behind a UK legal ID, e.g. 'uk:statutes/ukpga/2007/3/35'. Use this when the user asks for the source of a number or rule. Strip any '#rule_name' suffix.",
    parameters: z.object({
      legal_id: z.string().describe("Legal ID returned by list_encoded_outputs. Strip any '#rule_name' suffix."),
    }),
    execute: async ({ legal_id }) => {
      try {
        return await fetchCitation(legal_id);
      } catch (err) {
        console.error("[finbot] fetch_citation failed:", err);
        throw err;
      }
    },
  }),
};

export function toolsForCountry(country: Country) {
  return country === "uk" ? ukTools : usTools;
}

/** Back-compat default — old callers get the US tool surface. */
export const tools = usTools;

function dedupeOutputs<T extends { id: string }>(outputs: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const output of outputs) {
    if (seen.has(output.id)) continue;
    seen.add(output.id);
    unique.push(output);
  }
  return unique;
}
