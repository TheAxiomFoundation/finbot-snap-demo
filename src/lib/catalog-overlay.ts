/**
 * Optional per-program overrides, applied on top of the generated catalog.
 *
 * The catalog generator (scripts/generate-catalog.ts) derives display names,
 * descriptions, and primary outputs heuristically from the release manifest
 * and compiled artifacts. When a heuristic picks wrong for a specific program,
 * override it here instead of special-casing the generator. Keys are artifact
 * slugs (`us-co-snap`, `us-fiit`). Everything degrades gracefully when absent.
 */
export interface ProgramOverlay {
  display_name?: string;
  description?: string;
  /** Rule name (not legal id) of the headline output. */
  primary_output?: string;
  /** Starter prompts surfaced on the chat home when this program is featured. */
  starters?: string[];
  /** Curated input-slot defaults, applied last (provenance: "overlay").
   *  Reserved for facts the encoding models as inputs but that are properties
   *  of the law or of virtually every real scenario — law-variant switches
   *  (which statute regime applies this period) and always-true
   *  administrative facts. Never household-specific facts. Each entry should
   *  say why. Disclosed in describe_program and on /programs. */
  default_overrides?: Record<string, boolean | number | string>;
}

export const CATALOG_OVERLAY: Record<string, ProgramOverlay> = {
  "us-fiit": {
    // Manifest order puts breakdown components after the headline figure and
    // the `_tax`-suffix heuristic would land on alternative_minimum_tax.
    primary_output: "income_tax_before_refundable_credits",
    default_overrides: {
      // §24(h) (TCJA as amended by OBBBA — $2,200/child, $400k/$200k
      // thresholds) applies to every 2026 return; the encoding models its
      // applicability as an input. Without this the defaults compute the
      // permanent-law text ($1,000/child, $75k/$110k thresholds).
      ctc_subsection_h_special_rules_apply: true,
      // A normal calendar-year return is a full 12-month taxable year; the
      // CTC full-year requirement reads this input directly.
      taxable_year_months: 12,
    },
  },
};
