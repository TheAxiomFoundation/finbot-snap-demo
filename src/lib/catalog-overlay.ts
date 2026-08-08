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

/** Defaults applied to ANY program that has the slot (before per-program
 *  overrides). Only for facts that are administratively true for essentially
 *  every user of this app — asking about a state's program presumes applying
 *  in that state. */
export const GLOBAL_DEFAULT_OVERRIDES: Record<string, boolean | number | string> = {
  // 7 CFR 273.3 residency: the household applies in the state it lives in.
  household_lives_in_application_state: true,
  // Proration inputs (e.g. KS TANF): a full ongoing month. day=1 with 31
  // days makes the proration ratio exactly 1 for any month; defaults of 0
  // zero the benefit instead.
  days_in_month: 31,
  application_day_of_month: 1,
  // 7 CFR 273.7(a) general work requirement: the compliant judgment is a
  // conjunction of procedural facts that are administratively true for a
  // fresh applicant — the state agency registers members at application
  // (273.7(a)(2)(i)), and the "if assigned / if referred / if offered"
  // conditionals are vacuously satisfied before any assignment exists.
  // Left at false they zero every non-exempt adult's benefit in programs
  // that compose the work gate (e.g. us-ny-snap), while programs that don't
  // compose it stay unaffected — the source of cross-state $0 flakes.
  // Genuine noncompliance is still expressible by setting one false.
  member_registered_for_work_or_registered_by_state: true,
  member_participated_in_snap_et_if_assigned: true,
  member_participated_in_workfare_if_assigned: true,
  member_provided_employment_status_or_availability_information: true,
  member_reported_to_referred_suitable_employer_if_referred: true,
  member_accepted_bona_fide_suitable_employment_offer_if_offered: true,
  // Colorado's encoding spells the same 273.7(a) compliance facts its own
  // way (10 CCR 2506-1 restates the federal rule). Off the certified path
  // today, but cover them so a future artifact pin promoting them cannot
  // silently reintroduce the $0 flake, and so describe_program never shows
  // a fresh applicant as compliant and noncompliant on the same legal fact.
  member_registered_for_work_at_initial_application_or_recognition_by_required_signature: true,
  member_registered_for_work_at_recognition_by_required_signature: true,
  member_provided_eligibility_technician_sufficient_employment_status_or_availability_information: true,
  member_reported_to_employer_if_referred_by_local_office_and_potential_employment_was_suitable: true,
  member_accepted_offer_of_suitable_employment: true,
};

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
      // CTC full-year requirement reads taxable_year_months and the EITC
      // demographic test reads the boolean twin.
      taxable_year_months: 12,
      taxable_year_is_full_12_months: true,
    },
  },
};
