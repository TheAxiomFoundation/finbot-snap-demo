/**
 * Encoded-program catalog. The expansion seam: drop a new entry here and the
 * `list_encoded_outputs` tool exposes it to the LLM automatically.
 */
export interface EncodedProgram {
  slug: string;
  jurisdiction: string;
  display_name: string;
  scope: string;
  rulespec_path: string;
  outputs: Array<{
    legal_id: string;
    label: string;
    kind: "scalar" | "judgment";
    short: string;
  }>;
  primary_output: string;
}

export const CATALOG: EncodedProgram[] = [
  {
    slug: "co-snap",
    jurisdiction: "us-co",
    display_name: "Colorado SNAP — FY 2026 benefit calculation",
    scope: "Monthly benefit and eligibility for Colorado SNAP households as of FY 2026.",
    rulespec_path: "rulespec-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml",
    outputs: [
      { legal_id: "us:statutes/7/2017/a#snap_regular_month_allotment", label: "Regular monthly SNAP allotment", kind: "scalar", short: "Final monthly allotment in dollars before initial-month proration." },
      { legal_id: "us-co:regulations/10-ccr-2506-1/4.207.2#snap_allotment", label: "Colorado SNAP allotment", kind: "scalar", short: "Allotment after Colorado's proration rules." },
      { legal_id: "us-co:policies/cdhs/snap/fy-2026-benefit-calculation#snap_eligible", label: "Eligible for SNAP this month", kind: "judgment", short: "Composite eligibility judgment." },
      { legal_id: "us-co:regulations/10-ccr-2506-1/4.401#snap_income_eligible", label: "Income eligible", kind: "judgment", short: "Whether the household passes gross/net income tests." },
      { legal_id: "us:regulations/7-cfr/273/8#snap_resource_eligible", label: "Resource eligible", kind: "judgment", short: "Whether countable resources are below the asset limit." },
      { legal_id: "us:policies/usda/snap/fy-2026-cola/maximum-allotments#snap_maximum_allotment", label: "Maximum SNAP allotment for household size", kind: "scalar", short: "USDA FY 2026 max allotment table for the household's size." },
    ],
    primary_output: "us:statutes/7/2017/a#snap_regular_month_allotment",
  },
];

export function programsForJurisdiction(jurisdiction?: string): EncodedProgram[] {
  if (!jurisdiction) return CATALOG;
  return CATALOG.filter((p) => p.jurisdiction === jurisdiction);
}
