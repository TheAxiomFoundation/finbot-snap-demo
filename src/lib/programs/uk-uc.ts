/**
 * UK Universal Credit — typed user-facing fact contract bound to the
 * composed FY 2026-27 artifact (axiom-programs/uk/universal-credit).
 *
 * The composition wires WRA 2012 s.8 (award = maximum − deductions) to UC
 * Regs 2013 regs 22, 24, 26, 27, 29, 34, and 36, so this tool returns the
 * actual award after the work allowance and the 55% earned-income taper —
 * not just the sum of element amounts.
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

const ARTIFACT_SLUG = "uk-uc";
const FAMILY_ID = "f1";
const PRIMARY_ADULT_ID = "p_primary";
const SECOND_ADULT_ID = "p_second";
const INPUT_PREFIX = "axiom:uc-fy-2026-27#input.";

const INTERVAL_START_FALLBACK = 2025;

export interface UkUcFacts {
  /** Calendar year the UK tax year starts. Default 2025. */
  tax_year_start?: number;

  // Adult composition
  /** True for a couple claiming jointly; false for a single claim. Default false. */
  is_joint_claim?: boolean;
  /** Eldest adult age. Drives the under-25 / 25+ standard allowance band. Default 30. */
  eldest_adult_age?: number;

  // Children
  /** Children or qualifying young persons the claimant is responsible for. Default 0. */
  number_of_children?: number;
  /** Children eligible for the disabled-child lower-rate supplement. Default 0. */
  number_of_disabled_children_lower_rate?: number;
  /** Children eligible for the disabled-child higher-rate supplement. Default 0. */
  number_of_disabled_children_higher_rate?: number;

  // LCWRA / carer
  /** A claimant has LCWRA (Limited Capability for Work and Work-Related Activity). Default false. */
  has_lcwra?: boolean;
  /** Pre-commencement (protected) LCWRA award. Drives the higher amount. Default false. */
  is_pre_commencement_lcwra?: boolean;
  /** A claimant qualifies for the carer element. Default false. */
  has_carer?: boolean;

  // Childcare
  /** Children in registered childcare. Drives the childcare costs cap. Default 0. */
  number_of_children_in_childcare?: number;
  /** Actual childcare costs paid in the assessment period, in £. Default 0 (no childcare element). */
  childcare_costs_paid_monthly?: number;

  // Income — drives the work allowance + 55% taper in reg 22.
  /** Monthly earned income — single-claim case, in £. Default 0. */
  monthly_earned_income?: number;
  /** Monthly unearned income — single-claim case, in £. Default 0. */
  monthly_unearned_income?: number;
  /** Joint monthly earned income, in £. Used when is_joint_claim is true. Default 0. */
  joint_monthly_earned_income?: number;
  /** Joint monthly unearned income, in £. Used when is_joint_claim is true. Default 0. */
  joint_monthly_unearned_income?: number;
}

interface ChildSpec {
  id: string;
  is_first: boolean;
  disabled_lower: boolean;
  disabled_higher: boolean;
}

function adultPersonIds(is_joint: boolean): string[] {
  return is_joint ? [PRIMARY_ADULT_ID, SECOND_ADULT_ID] : [PRIMARY_ADULT_ID];
}

function childSpecs(facts: UkUcFacts): ChildSpec[] {
  const n = Math.max(0, facts.number_of_children ?? 0);
  const lower = Math.max(0, facts.number_of_disabled_children_lower_rate ?? 0);
  const higher = Math.max(0, facts.number_of_disabled_children_higher_rate ?? 0);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    is_first: i === 0,
    disabled_lower: i < lower,
    disabled_higher: i < higher,
  }));
}

function buildRequest(facts: UkUcFacts): { req: ExecutionRequest; children: ChildSpec[]; adultIds: string[] } {
  const taxYearStart = facts.tax_year_start ?? INTERVAL_START_FALLBACK;
  const { interval, period } = taxYearInterval(taxYearStart);

  const isJoint = !!facts.is_joint_claim;
  const eldestAge = facts.eldest_adult_age ?? 30;
  const age25plus = eldestAge >= 25;
  const adultIds = adultPersonIds(isJoint);
  const children = childSpecs(facts);
  const hasChildren = children.length > 0;

  // Family-scope overrides (apply to the Family entity row).
  const familyOverrides: Record<string, boolean | number | string> = {
    award_is_for_joint_claimants: isJoint,
    claim_is_for_joint_claimants: isJoint,
    claimant_is_member_of_couple: isJoint,
    claimant_makes_claim_as_single_person: !isJoint,
    single_claimant_is_aged_25_or_over: !isJoint && age25plus,
    either_joint_claimant_is_aged_25_or_over: isJoint && age25plus,
    single_claimant_responsible_for_child_or_qualifying_young_person: !isJoint && hasChildren,
    joint_claimants_responsible_for_child_or_qualifying_young_person: isJoint && hasChildren,
    claimant_earned_income_in_assessment_period: facts.monthly_earned_income ?? 0,
    claimant_unearned_income_in_assessment_period: facts.monthly_unearned_income ?? 0,
    joint_claimants_combined_earned_income_in_assessment_period: facts.joint_monthly_earned_income ?? 0,
    joint_claimants_combined_unearned_income_in_assessment_period: facts.joint_monthly_unearned_income ?? 0,
    childcare_costs_element_child_count: Math.max(0, facts.number_of_children_in_childcare ?? 0),
    charges_paid_for_relevant_childcare_attributable_to_assessment_period:
      facts.childcare_costs_paid_monthly ?? 0,
    single_claimant_has_limited_capability_for_work_and_work_related_activity:
      !isJoint && !!facts.has_lcwra,
    one_or_both_joint_claimants_have_limited_capability_for_work:
      isJoint && !!facts.has_lcwra,
    first_joint_claimant_has_limited_capability_for_work_and_work_related_activity:
      isJoint && !!facts.has_lcwra,
  };

  // Primary-adult-scope overrides.
  const primaryAdultOverrides: Record<string, boolean | number | string> = {
    claim_is_for_joint_claimants: isJoint,
    claimant_responsible_for_child_or_qualifying_young_person: hasChildren,
    claimant_has_limited_capability_for_work_and_work_related_activity: !!facts.has_lcwra,
    claimant_is_pre_commencement_lcwra_claimant: !!facts.is_pre_commencement_lcwra,
    carer_element_applies: !!facts.has_carer,
    claimant_is_the_only_relevant_carer_or_is_elected_or_determined_for_carer_element: !!facts.has_carer,
  };

  // Second-adult overrides for joint claims (kept empty by default — second
  // adult is a "placeholder" so the relations resolve, no second-claimant
  // facts surface).
  const secondAdultOverrides: Record<string, boolean | number | string> = {
    claim_is_for_joint_claimants: isJoint,
  };

  function emitSlots(entityKind: "Family" | "Person", entityId: string, overrides: Record<string, boolean | number | string>): InputRecord[] {
    const out: InputRecord[] = [];
    for (const name of UK_UC_BASE.bool_inputs) {
      out.push({
        name: INPUT_PREFIX + name,
        entity: entityKind,
        entity_id: entityId,
        interval,
        value: fact(overrides[name] ?? false, "bool"),
      });
    }
    for (const name of UK_UC_BASE.integer_inputs) {
      out.push({
        name: INPUT_PREFIX + name,
        entity: entityKind,
        entity_id: entityId,
        interval,
        value: fact((overrides[name] as number) ?? 0, "integer"),
      });
    }
    for (const name of UK_UC_BASE.decimal_inputs) {
      out.push({
        name: INPUT_PREFIX + name,
        entity: entityKind,
        entity_id: entityId,
        interval,
        value: fact((overrides[name] as number) ?? 0, "decimal"),
      });
    }
    return out;
  }

  function childOverrides(c: ChildSpec): Record<string, boolean | number | string> {
    return {
      child_is_first_child_or_qualifying_young_person: c.is_first,
      child_is_second_or_subsequent_child_or_qualifying_young_person: !c.is_first,
      disabled_child_lower_rate_applies: c.disabled_lower,
      disabled_child_higher_rate_applies: c.disabled_higher,
      // Reg 24 keys responsible_child_element_included_amount on this flag
      // being true on the child Person row.
      claimant_responsible_for_child_or_qualifying_young_person: true,
    };
  }

  const inputs: InputRecord[] = [
    ...emitSlots("Family", FAMILY_ID, familyOverrides),
    ...emitSlots("Person", PRIMARY_ADULT_ID, primaryAdultOverrides),
    ...(isJoint ? emitSlots("Person", SECOND_ADULT_ID, secondAdultOverrides) : []),
    ...children.flatMap((c) => emitSlots("Person", c.id, childOverrides(c))),
  ];

  const relations = [
    ...adultIds.map((id) => ({
      name: "adult_of_benefit_unit",
      tuple: [id, FAMILY_ID] as [string, string],
      interval,
    })),
    ...children.map((c) => ({
      name: "child_of_benefit_unit",
      tuple: [c.id, FAMILY_ID] as [string, string],
      interval,
    })),
  ];

  // The compose artifact's evaluation pulls aggregations across the
  // adult/child relations, so explain mode is the right path (fast mode
  // would require every input on every entity to be uniform — which is
  // what we already do, but explain is more forgiving for cross-entity
  // sums).
  const req: ExecutionRequest = {
    mode: "explain",
    dataset: { inputs, relations },
    queries: [
      {
        entity_id: FAMILY_ID,
        period,
        outputs: Object.values(UK_UC_BASE.outputs),
      },
    ],
  };
  return { req, children, adultIds };
}

export interface UkUcResult {
  /** Headline: actual UC monthly award after work allowance + 55% taper. */
  universal_credit_award_amount: number;
  outputs: {
    universal_credit_award_amount: number;
    universal_credit_maximum_amount: number;
    universal_credit_amounts_to_be_deducted: number;
    standard_allowance_amount: number;
    earned_income_deduction_from_maximum_amount: number;
    applicable_work_allowance_amount: number;
    earned_income_amount_subject_to_taper: number;
    childcare_costs_element_amount: number;
  };
  inputs_used: UkUcFacts;
  tax_year: string;
  citations: Array<{ id: string; url: string }>;
  raw: ExecutionResponse;
}

/** The composed artifact's section-10 bridge sums `responsible_child_element_included_amount`
 *  and `disabled_child_additional_amount` across `child_of_benefit_unit`, but reads them as
 *  `kind: input` rather than as derived rules — so we need a pre-pass to grab the per-child
 *  amounts and feed them back as inputs on each child Person. */
async function precomputeChildAmounts(facts: UkUcFacts): Promise<Map<string, { child: number; disabled: number }>> {
  const children = childSpecs(facts);
  if (children.length === 0) return new Map();
  const { req } = buildRequest(facts);
  // Replace the queries with per-child Person queries against the reg 24/36 derived rules.
  const { period } = taxYearInterval(facts.tax_year_start ?? INTERVAL_START_FALLBACK);
  req.queries = children.map((c) => ({
    entity_id: c.id,
    period,
    outputs: [
      "uk:regulations/uksi/2013/376/24#responsible_child_element_included_amount",
      "uk:regulations/uksi/2013/376/36#disabled_child_additional_amount",
    ],
  }));
  const res = await runCompiled(ARTIFACT_SLUG, req);
  const map = new Map<string, { child: number; disabled: number }>();
  res.results.forEach((row, i) => {
    const id = children[i].id;
    const child = readOutput(row.outputs["uk:regulations/uksi/2013/376/24#responsible_child_element_included_amount"])?.numeric ?? 0;
    const disabled = readOutput(row.outputs["uk:regulations/uksi/2013/376/36#disabled_child_additional_amount"])?.numeric ?? 0;
    map.set(id, { child, disabled });
  });
  return map;
}

export async function computeUkUniversalCredit(facts: UkUcFacts): Promise<UkUcResult> {
  // Pass 1: get per-child responsible_child_element_included_amount (reg 24)
  // and disabled_child_additional_amount (reg 36) so we can feed them as inputs
  // to the s.10 bridge in pass 2.
  const childAmounts = await precomputeChildAmounts(facts);

  // Pass 2: build the full request, overriding per-child input slots with
  // the values pass 1 gave us, then query for the final award.
  const { req, children } = buildRequest(facts);
  for (const inp of req.dataset.inputs) {
    if (inp.entity !== "Person") continue;
    const m = childAmounts.get(inp.entity_id);
    if (!m) continue;
    if (inp.name === INPUT_PREFIX + "responsible_child_element_included_amount") {
      inp.value = fact(m.child, "decimal");
    } else if (inp.name === INPUT_PREFIX + "disabled_child_additional_amount") {
      inp.value = fact(m.disabled, "decimal");
    }
  }
  // Silence the unused-var warning while keeping the shape parallel.
  void children;
  const res = await runCompiled(ARTIFACT_SLUG, req);
  const row = res.results[0];

  const num = (legalId: string): number => {
    const out = row?.outputs[legalId];
    if (!out) return 0;
    return readOutput(out).numeric ?? 0;
  };

  const m = UK_UC_BASE.outputs;
  const outputs = {
    universal_credit_award_amount: num(m.universal_credit_award_amount),
    universal_credit_maximum_amount: num(m.universal_credit_maximum_amount),
    universal_credit_amounts_to_be_deducted: num(m.universal_credit_amounts_to_be_deducted),
    standard_allowance_amount: num(m.standard_allowance_amount),
    earned_income_deduction_from_maximum_amount: num(m.earned_income_deduction_from_maximum_amount),
    applicable_work_allowance_amount: num(m.applicable_work_allowance_amount),
    earned_income_amount_subject_to_taper: num(m.earned_income_amount_subject_to_taper),
    childcare_costs_element_amount: num(m.childcare_costs_element_amount),
  };

  const startYear = facts.tax_year_start ?? INTERVAL_START_FALLBACK;
  return {
    universal_credit_award_amount: outputs.universal_credit_award_amount,
    outputs,
    inputs_used: { ...facts },
    tax_year: `${startYear}-${(startYear + 1).toString().slice(2)}`,
    citations: [
      { id: "uk:statutes/ukpga/2012/5/8", url: "https://app.axiom-foundation.org/uk/statute/ukpga/2012/5/8" },
      { id: "uk:regulations/uksi/2013/376/22", url: "https://app.axiom-foundation.org/uk/regulation/uksi/2013/376/22" },
      { id: "uk:regulations/uksi/2013/376/36", url: "https://app.axiom-foundation.org/uk/regulation/uksi/2013/376/36" },
    ],
    raw: res,
  };
}

export function isUkUcLegalId(legalId: string): boolean {
  return (
    legalId.startsWith("uk:statutes/ukpga/2012/5/") ||
    legalId.startsWith("uk:regulations/uksi/2013/376/") ||
    legalId.startsWith("axiom-programs:uk/universal-credit/")
  );
}
