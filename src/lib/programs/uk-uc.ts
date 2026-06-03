/**
 * UK Universal Credit elements (UC Regs 2013 reg 36) — typed user-facing fact
 * contract bound to the compiled axiom-rules-engine artifact.
 *
 * Returns the six element amounts that go into the UC maximum award:
 * standard allowance, child element (per child), disabled child supplement,
 * LCWRA element, carer element, childcare costs max. Sums them into a
 * single max_uc_monthly_amount so the model has one headline number.
 *
 * Out of scope for this tool (engine doesn't have it self-contained yet):
 * the work allowance, the income taper, the benefit cap, and the actual
 * award after deductions. WRA 2012 s.8 ("award = max − deductions")
 * exists in rulespec-uk but references slot names that aren't yet wired
 * to reg 36's exported outputs.
 */
import {
  type ExecutionRequest,
  type ExecutionResponse,
  type InputRecord,
  fact,
  readOutput,
  taxYearInterval,
  runCompiled,
} from "../engine";
import { UK_UC_BASE } from "./uk-uc-base";

const ARTIFACT_SLUG = "uk-uc-reg36";
const FAMILY_ID = "f1";
const INPUT_PREFIX = "uk:regulations/uksi/2013/376/36#input.";

export interface UkUcFacts {
  /** Calendar year the UK tax year starts. Default 2025. */
  tax_year_start?: number;
  /** True for a joint claim by a couple; false for a single claim. Default false. */
  is_joint_claim?: boolean;
  /** Eldest adult age in the family. Drives the standard allowance under-25 / 25+ band. */
  eldest_adult_age?: number;
  /** Total number of children or qualifying young persons for whom the claimant is responsible. Default 0. */
  number_of_children?: number;
  /** Children eligible for the disabled-child lower-rate supplement. Default 0. */
  number_of_disabled_children_lower_rate?: number;
  /** Children eligible for the disabled-child higher-rate supplement. Default 0. */
  number_of_disabled_children_higher_rate?: number;
  /** True if a claimant has LCWRA (Limited Capability for Work and Work-Related Activity). Default false. */
  has_lcwra?: boolean;
  /** True if the LCWRA claimant has a protected pre-commencement award (the higher amount). Default false. */
  is_pre_commencement_lcwra?: boolean;
  /** True if a claimant has regular and substantial caring responsibilities. Default false. */
  has_carer?: boolean;
  /** Number of children in registered childcare (drives the childcare costs cap). Default 0. */
  number_of_children_in_childcare?: number;
}

interface PersonSpec {
  id: string;
  role: "first_child" | "subsequent_child" | "disabled_lower" | "disabled_higher" | "lcwra" | "carer";
  inputs: Record<string, boolean | number | string>;
}

function buildPersons(facts: UkUcFacts): PersonSpec[] {
  const persons: PersonSpec[] = [];
  const nChildren = Math.max(0, facts.number_of_children ?? 0);
  const nDisLow = Math.max(0, facts.number_of_disabled_children_lower_rate ?? 0);
  const nDisHigh = Math.max(0, facts.number_of_disabled_children_higher_rate ?? 0);
  for (let i = 0; i < nChildren; i++) {
    const isFirst = i === 0;
    const disLowApplies = i < nDisLow;
    const disHighApplies = i < nDisHigh;
    persons.push({
      id: `child_${i + 1}`,
      role: isFirst ? "first_child" : "subsequent_child",
      inputs: {
        child_is_first_child_or_qualifying_young_person: isFirst,
        child_is_second_or_subsequent_child_or_qualifying_young_person: !isFirst,
        disabled_child_lower_rate_applies: disLowApplies,
        disabled_child_higher_rate_applies: disHighApplies,
        claimant_has_limited_capability_for_work_and_work_related_activity: false,
        claimant_is_pre_commencement_lcwra_claimant: false,
        claimant_is_severe_conditions_criteria_claimant: false,
        claimant_is_terminally_ill: false,
        carer_element_applies: false,
      },
    });
  }
  if (facts.has_lcwra) {
    persons.push({
      id: "lcwra_claimant",
      role: "lcwra",
      inputs: {
        child_is_first_child_or_qualifying_young_person: false,
        child_is_second_or_subsequent_child_or_qualifying_young_person: false,
        disabled_child_lower_rate_applies: false,
        disabled_child_higher_rate_applies: false,
        claimant_has_limited_capability_for_work_and_work_related_activity: true,
        claimant_is_pre_commencement_lcwra_claimant: !!facts.is_pre_commencement_lcwra,
        claimant_is_severe_conditions_criteria_claimant: false,
        claimant_is_terminally_ill: false,
        carer_element_applies: false,
      },
    });
  }
  if (facts.has_carer) {
    persons.push({
      id: "carer_claimant",
      role: "carer",
      inputs: {
        child_is_first_child_or_qualifying_young_person: false,
        child_is_second_or_subsequent_child_or_qualifying_young_person: false,
        disabled_child_lower_rate_applies: false,
        disabled_child_higher_rate_applies: false,
        claimant_has_limited_capability_for_work_and_work_related_activity: false,
        claimant_is_pre_commencement_lcwra_claimant: false,
        claimant_is_severe_conditions_criteria_claimant: false,
        claimant_is_terminally_ill: false,
        carer_element_applies: true,
      },
    });
  }
  return persons;
}

function buildRequest(facts: UkUcFacts, persons: PersonSpec[]): ExecutionRequest {
  const taxYearStart = facts.tax_year_start ?? 2025;
  const { interval, period } = taxYearInterval(taxYearStart);

  const familyInputsRaw: Record<string, boolean | number | string> = {
    award_is_for_joint_claimants: !!facts.is_joint_claim,
    single_claimant_is_aged_25_or_over: !facts.is_joint_claim && (facts.eldest_adult_age ?? 30) >= 25,
    either_joint_claimant_is_aged_25_or_over: !!facts.is_joint_claim && (facts.eldest_adult_age ?? 30) >= 25,
    childcare_costs_element_child_count: Math.max(0, facts.number_of_children_in_childcare ?? 0),
  };

  const familyInputs: InputRecord[] = UK_UC_BASE.family_inputs.map((slot) => ({
    name: INPUT_PREFIX + slot.name,
    entity: "Family",
    entity_id: FAMILY_ID,
    interval,
    value: fact(
      familyInputsRaw[slot.name] ?? slot.default,
      slot.dtype as "bool" | "integer" | "decimal" | "date" | "text"
    ),
  }));

  const personInputs: InputRecord[] = persons.flatMap((p) =>
    UK_UC_BASE.person_inputs.map((slot) => ({
      name: INPUT_PREFIX + slot.name,
      entity: "Person" as const,
      entity_id: p.id,
      interval,
      value: fact(
        p.inputs[slot.name] ?? slot.default,
        slot.dtype as "bool" | "integer" | "decimal" | "date" | "text"
      ),
    }))
  );

  const familyOutputs = Object.values(UK_UC_BASE.family_outputs);
  const personOutputs = Object.values(UK_UC_BASE.person_outputs);

  return {
    // The fast-path bulk evaluator wants every declared input set on every
    // entity in the dataset; explain mode evaluates per-entity which lets us
    // scope Family-only and Person-only inputs to their own entity rows.
    mode: "explain",
    dataset: { inputs: [...familyInputs, ...personInputs], relations: [] },
    queries: [
      { entity_id: FAMILY_ID, period, outputs: familyOutputs },
      ...persons.map((p) => ({ entity_id: p.id, period, outputs: personOutputs })),
    ],
  };
}

export interface UkUcResult {
  /** Sum of every element returned by the engine (standard allowance + child + disabled supplements + LCWRA + carer + childcare max). */
  max_uc_monthly_amount: number;
  outputs: {
    standard_allowance_amount: number;
    total_child_element_amount: number;
    total_disabled_child_additional_amount: number;
    lcwra_element_amount: number;
    carer_element: number;
    childcare_costs_element_maximum_amount: number;
  };
  per_child: Array<{ id: string; child_element_amount: number; disabled_child_additional_amount: number }>;
  inputs_used: UkUcFacts;
  tax_year: string;
  citations: Array<{ id: string; url: string }>;
  raw: ExecutionResponse;
}

export async function computeUkUniversalCreditElements(facts: UkUcFacts): Promise<UkUcResult> {
  const persons = buildPersons(facts);
  const req = buildRequest(facts, persons);
  const res = await runCompiled(ARTIFACT_SLUG, req);

  // Result rows are keyed by entity_id in order of the queries we sent.
  const familyResult = res.results[0];
  const personResults = res.results.slice(1);

  const num = (id: string, row: typeof familyResult): number => {
    const out = row?.outputs[id];
    if (!out) return 0;
    return readOutput(out).numeric ?? 0;
  };

  const standard_allowance_amount = num(UK_UC_BASE.family_outputs.standard_allowance_amount, familyResult);
  const childcare_costs_element_maximum_amount = num(UK_UC_BASE.family_outputs.childcare_costs_element_maximum_amount, familyResult);

  let total_child_element_amount = 0;
  let total_disabled_child_additional_amount = 0;
  let lcwra_element_amount = 0;
  let carer_element = 0;
  const per_child: UkUcResult["per_child"] = [];

  personResults.forEach((row, i) => {
    const spec = persons[i];
    const child = num(UK_UC_BASE.person_outputs.child_element_amount, row);
    const disabled = num(UK_UC_BASE.person_outputs.disabled_child_additional_amount, row);
    const lcwra = num(UK_UC_BASE.person_outputs.lcwra_element_amount, row);
    const carer = num(UK_UC_BASE.person_outputs.carer_element, row);
    if (spec.role === "first_child" || spec.role === "subsequent_child") {
      total_child_element_amount += child;
      total_disabled_child_additional_amount += disabled;
      per_child.push({ id: spec.id, child_element_amount: child, disabled_child_additional_amount: disabled });
    }
    if (spec.role === "lcwra") lcwra_element_amount = lcwra;
    if (spec.role === "carer") carer_element = carer;
  });

  const max_uc_monthly_amount =
    standard_allowance_amount +
    total_child_element_amount +
    total_disabled_child_additional_amount +
    lcwra_element_amount +
    carer_element +
    childcare_costs_element_maximum_amount;

  const startYear = facts.tax_year_start ?? 2025;
  return {
    max_uc_monthly_amount,
    outputs: {
      standard_allowance_amount,
      total_child_element_amount,
      total_disabled_child_additional_amount,
      lcwra_element_amount,
      carer_element,
      childcare_costs_element_maximum_amount,
    },
    per_child,
    inputs_used: { ...facts },
    tax_year: `${startYear}-${(startYear + 1).toString().slice(2)}`,
    citations: [
      {
        id: "uk:regulations/uksi/2013/376/36",
        url: "https://app.axiom-foundation.org/uk/regulation/uksi/2013/376/36",
      },
    ],
    raw: res,
  };
}

export function isUkUcLegalId(legalId: string): boolean {
  return legalId.startsWith("uk:regulations/uksi/2013/376/36#")
    || legalId.startsWith("uk:statutes/ukpga/2012/5/");
}
