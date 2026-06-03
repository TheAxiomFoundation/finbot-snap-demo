// UK Universal Credit Regulations 2013, regulation 36 — the table of element
// amounts for the UC monthly award. Handwritten (13 inputs, 6 outputs) from
// engine/artifacts/uk-uc-reg36.compiled.json.
//
// To rebuild the artifact:
//   AXIOM_RULES_ENGINE_BINARY=engine/axiom-rules/target/release/axiom-rules-engine \
//   AXIOM_RULE_REPO_ROOTS=engine \
//   engine/axiom-rules/target/release/axiom-rules-engine compile \
//     --program engine/rulespec-uk/regulations/uksi/2013/376/36.yaml \
//     --output engine/artifacts/uk-uc-reg36.compiled.json
//
// Note: WRA 2012 s.8 (award = max − deductions) is encoded but uses element
// slot names that don't match reg 36's exported names. A composing YAML
// upstream would unlock a real "calculate my UC award" computation; until
// then we sum the elements in TS.

export const UK_UC_BASE = {
  schema: "uk-uc-elements.reg36",
  family_inputs: [
    { name: "award_is_for_joint_claimants", dtype: "bool", default: false },
    { name: "single_claimant_is_aged_25_or_over", dtype: "bool", default: false },
    { name: "either_joint_claimant_is_aged_25_or_over", dtype: "bool", default: false },
    { name: "childcare_costs_element_child_count", dtype: "integer", default: 0 },
  ] as const,
  person_inputs: [
    { name: "child_is_first_child_or_qualifying_young_person", dtype: "bool", default: false },
    { name: "child_is_second_or_subsequent_child_or_qualifying_young_person", dtype: "bool", default: false },
    { name: "disabled_child_lower_rate_applies", dtype: "bool", default: false },
    { name: "disabled_child_higher_rate_applies", dtype: "bool", default: false },
    { name: "claimant_has_limited_capability_for_work_and_work_related_activity", dtype: "bool", default: false },
    { name: "claimant_is_pre_commencement_lcwra_claimant", dtype: "bool", default: false },
    { name: "claimant_is_severe_conditions_criteria_claimant", dtype: "bool", default: false },
    { name: "claimant_is_terminally_ill", dtype: "bool", default: false },
    { name: "carer_element_applies", dtype: "bool", default: false },
  ] as const,
  family_outputs: {
    standard_allowance_amount:
      "uk:regulations/uksi/2013/376/36#standard_allowance_amount",
    childcare_costs_element_maximum_amount:
      "uk:regulations/uksi/2013/376/36#childcare_costs_element_maximum_amount",
  } as Record<string, string>,
  person_outputs: {
    child_element_amount:
      "uk:regulations/uksi/2013/376/36#child_element_amount",
    disabled_child_additional_amount:
      "uk:regulations/uksi/2013/376/36#disabled_child_additional_amount",
    lcwra_element_amount:
      "uk:regulations/uksi/2013/376/36#lcwra_element_amount",
    carer_element:
      "uk:regulations/uksi/2013/376/36#carer_element",
  } as Record<string, string>,
  all_outputs: [
    { name: "standard_allowance_amount", id: "uk:regulations/uksi/2013/376/36#standard_allowance_amount", entity: "Family", semantics: "scalar", dtype: "decimal", unit: "GBP", source: "Universal Credit Regulations 2013 reg 36 (Standard allowance)" },
    { name: "child_element_amount", id: "uk:regulations/uksi/2013/376/36#child_element_amount", entity: "Person", semantics: "scalar", dtype: "decimal", unit: "GBP", source: "Universal Credit Regulations 2013 reg 36 (Child element)" },
    { name: "disabled_child_additional_amount", id: "uk:regulations/uksi/2013/376/36#disabled_child_additional_amount", entity: "Person", semantics: "scalar", dtype: "decimal", unit: "GBP", source: "Universal Credit Regulations 2013 reg 36 (Disabled child)" },
    { name: "lcwra_element_amount", id: "uk:regulations/uksi/2013/376/36#lcwra_element_amount", entity: "Person", semantics: "scalar", dtype: "decimal", unit: "GBP", source: "Universal Credit Regulations 2013 reg 36 (LCWRA element)" },
    { name: "carer_element", id: "uk:regulations/uksi/2013/376/36#carer_element", entity: "Person", semantics: "scalar", dtype: "decimal", unit: "GBP", source: "Universal Credit Regulations 2013 reg 36 (Carer element)" },
    { name: "childcare_costs_element_maximum_amount", id: "uk:regulations/uksi/2013/376/36#childcare_costs_element_maximum_amount", entity: "Family", semantics: "scalar", dtype: "decimal", unit: "GBP", source: "Universal Credit Regulations 2013 reg 36 (Childcare costs)" },
  ] as const,
  corpus_paths: {
    "uk:regulations/uksi/2013/376/36": "uk/regulation/uksi/2013/376/36",
  },
} as const;
