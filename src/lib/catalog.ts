/**
 * Encoded-program catalog. The expansion seam: drop a new entry here and the
 * `list_encoded_outputs` tool exposes it to the LLM automatically.
 */
export type Country = "us" | "uk";

export interface EncodedProgram {
  slug: string;
  country: Country;
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
    country: "us",
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
  {
    slug: "ca-snap",
    country: "us",
    jurisdiction: "us-ca",
    display_name: "California SNAP — FY 2026 benefit calculation",
    scope: "Monthly benefit and eligibility for California SNAP households as of FY 2026.",
    rulespec_path: "rules-us-ca/programs/snap/fy-2026.yaml",
    outputs: [
      { legal_id: "us-ca:programs/snap/fy-2026#snap_benefit", label: "California SNAP benefit", kind: "scalar", short: "Final monthly SNAP benefit in dollars." },
      { legal_id: "us-ca:programs/snap/fy-2026#snap_eligible", label: "Eligible for SNAP this month", kind: "judgment", short: "Composite eligibility judgment." },
      { legal_id: "us-ca:programs/snap/fy-2026#snap_gross_monthly_income", label: "Gross monthly SNAP income", kind: "scalar", short: "Monthly earned plus unearned income." },
      { legal_id: "us-ca:programs/snap/fy-2026#snap_total_allowable_shelter_expenses", label: "Allowable shelter expenses", kind: "scalar", short: "Shelter expenses used by the SNAP calculation." },
    ],
    primary_output: "us-ca:programs/snap/fy-2026#snap_benefit",
  },
  {
    slug: "ny-snap",
    country: "us",
    jurisdiction: "us-ny",
    display_name: "New York SNAP — FY 2026 benefit calculation",
    scope: "Monthly benefit and eligibility for New York SNAP households as of FY 2026.",
    rulespec_path: "rules-us-ny/programs/snap/fy-2026.yaml",
    outputs: [
      { legal_id: "us-ny:programs/snap/fy-2026#snap_benefit", label: "New York SNAP benefit", kind: "scalar", short: "Final monthly SNAP benefit in dollars." },
      { legal_id: "us-ny:programs/snap/fy-2026#snap_eligible", label: "Eligible for SNAP this month", kind: "judgment", short: "Composite eligibility judgment." },
      { legal_id: "us-ny:programs/snap/fy-2026#snap_gross_monthly_income", label: "Gross monthly SNAP income", kind: "scalar", short: "Monthly earned plus unearned income." },
      { legal_id: "us-ny:programs/snap/fy-2026#snap_total_allowable_shelter_expenses", label: "Allowable shelter expenses", kind: "scalar", short: "Shelter expenses used by the SNAP calculation." },
    ],
    primary_output: "us-ny:programs/snap/fy-2026#snap_benefit",
  },
  {
    slug: "uk-universal-credit-elements",
    country: "uk",
    jurisdiction: "uk",
    display_name: "UK Universal Credit elements — UC Regs 2013 reg 36",
    scope: "The six element amounts that go into the Universal Credit maximum award: standard allowance, child element, disabled-child supplement, LCWRA element, carer element, and childcare costs cap. Sums them into max_uc_monthly_amount. Does NOT yet apply the work allowance, income taper, or benefit cap.",
    rulespec_path: "rulespec-uk/regulations/uksi/2013/376/36.yaml",
    outputs: [
      { legal_id: "uk:regulations/uksi/2013/376/36#standard_allowance_amount", label: "Standard allowance (monthly)", kind: "scalar", short: "Family-scope amount, picked by single/joint × under-25/25+." },
      { legal_id: "uk:regulations/uksi/2013/376/36#child_element_amount", label: "Child element (per child, monthly)", kind: "scalar", short: "Different rate for first vs subsequent child." },
      { legal_id: "uk:regulations/uksi/2013/376/36#disabled_child_additional_amount", label: "Disabled-child additional amount (per child, monthly)", kind: "scalar", short: "Lower or higher rate depending on disability." },
      { legal_id: "uk:regulations/uksi/2013/376/36#lcwra_element_amount", label: "LCWRA element (monthly)", kind: "scalar", short: "Limited Capability for Work and Work-Related Activity." },
      { legal_id: "uk:regulations/uksi/2013/376/36#carer_element", label: "Carer element (monthly)", kind: "scalar", short: "Family-scope amount when a claimant qualifies as a carer." },
      { legal_id: "uk:regulations/uksi/2013/376/36#childcare_costs_element_maximum_amount", label: "Childcare costs element max (monthly)", kind: "scalar", short: "Cap depending on number of children." },
    ],
    primary_output: "uk:regulations/uksi/2013/376/36#standard_allowance_amount",
  },
  {
    slug: "uk-personal-allowance",
    country: "uk",
    jurisdiction: "uk",
    display_name: "UK personal allowance — Income Tax Act 2007 s.35",
    scope: "Personal allowance for UK income tax, including the £100,000 adjusted-net-income taper. Tax year 2025-26.",
    rulespec_path: "rulespec-uk/statutes/ukpga/2007/3/35.yaml",
    outputs: [
      { legal_id: "uk:statutes/ukpga/2007/3/35#personal_allowance", label: "Personal allowance", kind: "scalar", short: "Allowance after the £100k taper, in £." },
      { legal_id: "uk:statutes/ukpga/2007/3/35#individual_entitled_to_personal_allowance", label: "Entitled to personal allowance", kind: "judgment", short: "Whether the individual meets s.35(1) and s.56 requirements." },
      { legal_id: "uk:statutes/ukpga/2007/3/35#personal_allowance_base_amount", label: "Personal allowance base amount", kind: "scalar", short: "Statutory base allowance before taper (£12,570)." },
      { legal_id: "uk:statutes/ukpga/2007/3/35#adjusted_net_income_reduction_threshold", label: "Taper threshold", kind: "scalar", short: "Adjusted-net-income threshold above which the allowance tapers (£100,000)." },
    ],
    primary_output: "uk:statutes/ukpga/2007/3/35#personal_allowance",
  },
];

export function programsForCountry(country: Country): EncodedProgram[] {
  return CATALOG.filter((p) => p.country === country);
}

export function programsForJurisdiction(jurisdiction?: string): EncodedProgram[] {
  if (!jurisdiction) return CATALOG;
  return CATALOG.filter((p) => p.jurisdiction === jurisdiction);
}
