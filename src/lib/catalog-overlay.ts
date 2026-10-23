/**
 * Optional per-program overrides, applied on top of the generated catalog.
 *
 * The catalog generator (scripts/generate-catalog.ts) derives display names,
 * descriptions, and primary outputs heuristically from the release manifest
 * and compiled artifacts. When a heuristic picks wrong for a specific program,
 * override it here instead of special-casing the generator. Keys are artifact
 * slugs (`us-co-snap`, `us-fiit`). Everything degrades gracefully when absent.
 */

/** A curated default the law itself changes on a date: `value` for
 *  evaluation periods that start before `before` (ISO date), `otherwise`
 *  from that date on. For statutory date tests the encoding takes as inputs
 *  (a provision's sunset), so a fixed value can't be right in every year. */
export interface PeriodDefault {
  before: string;
  value: boolean | number | string;
  otherwise: boolean | number | string;
}

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
  default_overrides?: Record<string, boolean | number | string | PeriodDefault>;
  /** Inputs that restate a value the same program's rules compute: a law
   *  value the encoding takes as an input (a poverty line by household
   *  size), or a figure its composition already derives (gross income).
   *  A fixed default can't be right for every household and year, so when
   *  the caller leaves one unset the compute reads the named output on the
   *  same facts and period first and sets the slot to it (validated in
   *  scripts/generate-catalog.ts: same entity, numeric, and the output
   *  doesn't read the slot). Reported in applied.derived_facts. Each entry
   *  should say why the two are the same quantity. */
  derived_inputs?: Record<string, { output: string }>;
  /** Limitations disclosed once on the relevant program's tool result. */
  notes?: string[];
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
  "us-ca-snap": {
    default_overrides: {
      // USDA FNS BBCE chart, June 2026: California confers BBCE on all
      // households through a pamphlet (PUB 275), subject to its 200% limit.
      // The compiled MCE path retains its member and household exclusions.
      // https://fns-prod.azureedge.us/sites/default/files/resource-files/BBCE-States-Chart-June2026.pdf
      household_was_issued_pub_275: true,
    },
  },
  "us-co-snap": {
    // USDA FNS BBCE chart, June 2026, lists an application notice for all
    // Colorado households at 200%. Do not default the corresponding flag:
    // this artifact's income path ignores expanded_categorical_eligibility_barred
    // (10 CCR 2506-1 4.206(C)(2)(c)), including an active SNAP IPV exclusion.
    // https://fns-prod.azureedge.us/sites/default/files/resource-files/BBCE-States-Chart-June2026.pdf
    notes: ["Axiom can't apply Colorado's broad-based categorical eligibility yet. A $0 for a household with gross income above the 130% limit but within the state's higher BBCE limit is not a determination; it may still qualify."],
  },
  "us-sc-snap": {
    // SNAP Manual 4.1(D) (Vol 73, October 2026): Family Independence
    // Information and Referral Services "are provided to households whose
    // income falls at or below 130% of the Federal Poverty Level (FPL)",
    // and "Categorical eligibility for these households does not continue
    // if gross income, upon verification, is above the identified FPL".
    // The encoding tests household_gross_income <= 1.3 *
    // federal_poverty_level_for_household and takes both as inputs. At
    // their 0 defaults the test held at any income (0 <= 0: a 1-person
    // household at 307% of poverty was eligible, $24); with gross income
    // set and the poverty level at 0 it failed at any income.
    // https://dss.sc.gov/media/llodk0kb/snap-manual-volume-73.pdf#page=43
    derived_inputs: {
      // The FY income eligibility standards' 100% column is the monthly
      // federal poverty level for the household's size (7 U.S.C. 2014(c)),
      // the figure the 130% gross limit beside it is computed from.
      federal_poverty_level_for_household: { output: "snap_net_income_limit_100_percent_fpl_48_states_dc" },
      // Gross income is the composition's own earned plus unearned income;
      // the 4.1(D) test reads it from a separate input.
      household_gross_income: { output: "snap_gross_monthly_income" },
    },
  },
  "us-az-snap": {
    notes: ["Axiom's Arizona SNAP encoding doesn't test eligibility yet: every household shows as eligible, so read the amount as \"if eligible\"."],
  },
  "us-ma-snap": {
    notes: ["Axiom can't apply Massachusetts's broad-based categorical eligibility yet. A $0 for a household with gross income above the 130% limit but within the state's higher BBCE limit is not a determination; it may still qualify."],
  },
  "us-fl-snap": {
    notes: ["Axiom can't apply Florida's broad-based categorical eligibility yet. A $0 for a household with gross income above the 130% limit but within the state's higher BBCE limit is not a determination; it may still qualify."],
  },
  "us-al-snap": {
    notes: ["Axiom's Alabama SNAP encoding takes categorical eligibility as an unchecked input, which this assistant can't set."],
  },
  "us-tn-snap": {
    notes: ["Axiom's Tennessee SNAP encoding takes categorical eligibility as an unchecked input, which this assistant can't set."],
  },
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
      // Everyone this app answers files an individual return (Form 1040);
      // estates and trusts (Form 1041) are out of scope. 26 USC 151 and the
      // §55 domain test the taxpayer being an individual as an input; left
      // at false it withheld the senior deduction from a 70-year-old filer
      // whose compute omitted the fact.
      taxpayer_is_individual: true,
      // 26 USC 151(d)(5)(C)(i) (P.L. 119-21): the senior deduction applies
      // to "a taxable year beginning before January 1, 2029". The encoding
      // takes that date test as an input; left at false it withheld the
      // deduction from every 2026 return whose compute omitted the fact.
      taxable_year_begins_before_senior_deduction_termination: {
        before: "2029-01-01",
        value: true,
        otherwise: false,
      },
      // 26 USC 151(d)(5)(A): "In the case of a taxable year beginning after
      // December 31, 2017", the exemption amount "means zero" (no end date
      // since P.L. 119-21). The encoding takes that date test as an input;
      // left at false, exemption_amount read the $2,000 base, so lookup_value
      // gave $2,000 for 2026 and §55 added it back into amt_income.
      taxable_year_begins_after_exemption_amount_zero_start: {
        before: "2018-01-01",
        value: false,
        otherwise: true,
      },
    },
  },
};

/** Shared copy for program pages, describe_program, and computation cards.
 *  Period-dependent limitations (annual updates not encoded yet) come from
 *  the catalog instead — see src/lib/annual-updates.ts. */
export function programDisclosures(program: { slug: string; program_id: string }): string[] {
  return [...(CATALOG_OVERLAY[program.slug]?.notes ?? [])];
}
