// UK Income Tax Act 2007 s.35 — personal allowance, including the £100k taper.
// Hand-written (the compiled artifact has 3 Person inputs and 1 surface output;
// not worth a regenerate script yet). Mirrors the shape of co-snap-base.ts so
// the dashboard-style runtime adapter can consume it uniformly.
//
// To rebuild the artifact:
//   AXIOM_RULES_ENGINE_BINARY=engine/axiom-rules/target/release/axiom-rules-engine \
//   AXIOM_RULE_REPO_ROOTS=engine \
//   engine/axiom-rules/target/release/axiom-rules-engine compile \
//     --program engine/rulespec-uk/statutes/ukpga/2007/3/35.yaml \
//     --output engine/artifacts/uk-personal-allowance.compiled.json

export const UK_PERSONAL_ALLOWANCE_BASE = {
  schema: "uk-personal-allowance.s35",
  household_inputs: [] as ReadonlyArray<{ name: string; dtype: string; default: boolean | number | string }>,
  person_inputs: [
    { name: "adjusted_net_income", dtype: "decimal", default: 0 },
    { name: "individual_makes_claim", dtype: "bool", default: true },
    { name: "individual_meets_requirements_under_section_56", dtype: "bool", default: true },
  ] as const,
  relations: [] as ReadonlyArray<string>,
  // Surface = the headline output compute_uk_personal_allowance returns.
  outputs_by_name: {
    personal_allowance: "uk:statutes/ukpga/2007/3/35#personal_allowance",
  } as Record<string, string>,
  // Full output set for list_encoded_outputs / lookup_value.
  all_outputs: [
    {
      name: "personal_allowance",
      id: "uk:statutes/ukpga/2007/3/35#personal_allowance",
      entity: "Person",
      semantics: "scalar",
      dtype: "decimal",
      unit: "GBP",
      source: "Income Tax Act 2007 s.35(1)-(3)",
    },
    {
      name: "individual_entitled_to_personal_allowance",
      id: "uk:statutes/ukpga/2007/3/35#individual_entitled_to_personal_allowance",
      entity: "Person",
      semantics: "judgment",
      dtype: "judgment",
      unit: null,
      source: "Income Tax Act 2007 s.35(1)",
    },
    {
      name: "personal_allowance_base_amount",
      id: "uk:statutes/ukpga/2007/3/35#personal_allowance_base_amount",
      entity: "Scalar",
      semantics: "scalar",
      dtype: "decimal",
      unit: "GBP",
      source: "Income Tax Act 2007 s.35(1)",
    },
    {
      name: "adjusted_net_income_reduction_threshold",
      id: "uk:statutes/ukpga/2007/3/35#adjusted_net_income_reduction_threshold",
      entity: "Scalar",
      semantics: "scalar",
      dtype: "decimal",
      unit: "GBP",
      source: "Income Tax Act 2007 s.35(2)",
    },
  ] as const,
  // legal-id prefix → axiom-corpus citation path, for fetch_citation.
  corpus_paths: {
    "uk:statutes/ukpga/2007/3/35": "uk/statute/ukpga/2007/3/35",
    "uk:statutes/ukpga/2007/3/23": "uk/statute/legislation.gov.uk/ukpga/2007/3/section/23/block-13",
  },
} as const;
