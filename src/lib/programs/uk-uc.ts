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
const SERVICE_CHARGE_PAYMENT_ID = "pay_service_1";
const INPUT_PREFIX = "axiom:uc-fy-2026-27#input.";
const OWNER_OCCUPIER_SERVICE_CHARGE_RELATION =
  "uk:regulations/uksi/2013/376/schedule/5/paragraph/13#relation.owner_occupier_service_charge_payments";

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

  // Housing — shared-ownership path through UC Regs 2013 reg 26, Schedule 4,
  // and Schedule 5. These are deliberately narrow demo facts; deeper LHA and
  // tenure-specific determinations still belong in upstream encodings/data.
  /** Rent used as Schedule 4 core rent, in £/month. Default 0. */
  monthly_rent?: number;
  /** Rent cap used by Schedule 4 paragraph 22, in £/month. Defaults to monthly_rent. */
  monthly_rent_cap?: number;
  /** Count of non-dependants requiring the £96.55 housing-cost contribution. Default 0. */
  non_dependant_housing_cost_contribution_count?: number;
  /** Monthly owner-occupier service charge payment for Schedule 5, in £. Default 0. */
  monthly_owner_occupier_service_charge?: number;
  /** Weekly owner-occupier service charge payment for Schedule 5, in £. Default 0. */
  weekly_owner_occupier_service_charge?: number;
  /** Treat the claimant as holding a shared-ownership tenancy. Defaults to true when housing facts are supplied. */
  has_shared_ownership_tenancy?: boolean;
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
  const monthlyRent = Math.max(0, facts.monthly_rent ?? 0);
  const monthlyRentCap = Math.max(0, facts.monthly_rent_cap ?? monthlyRent);
  const monthlyServiceCharge = Math.max(0, facts.monthly_owner_occupier_service_charge ?? 0);
  const weeklyServiceCharge = Math.max(0, facts.weekly_owner_occupier_service_charge ?? 0);
  const hasServiceCharge = monthlyServiceCharge > 0 || weeklyServiceCharge > 0;
  const hasRent = monthlyRent > 0 || monthlyRentCap > 0;
  const hasHousing = hasRent || hasServiceCharge;
  const hasSharedOwnership = facts.has_shared_ownership_tenancy ?? hasHousing;

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
    award_contains_housing_costs_element: hasHousing,
    calculation_is_under_part_4_or_5_of_schedule: hasHousing,
    housing_cost_contribution_count_required_under_paragraph_13_in_renters_case:
      Math.max(0, facts.non_dependant_housing_cost_contribution_count ?? 0),
    renters_core_rent: monthlyRent,
    renters_cap_rent: monthlyRentCap,
    amount_resulting_from_all_other_steps_in_parts_4_and_5_calculation:
      Math.min(monthlyRent, monthlyRentCap),
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
    claimant_meets_all_conditions_specified_in_regulation_25: hasHousing,
    claimant_is_liable_for_rent_payments: hasRent,
    claimant_is_liable_for_service_charge_payments: hasServiceCharge,
    claimant_has_shared_ownership_tenancy_in_england_or_wales: hasSharedOwnership,
  };

  // Second-adult overrides for joint claims (kept empty by default — second
  // adult is a "placeholder" so the relations resolve, no second-claimant
  // facts surface).
  const secondAdultOverrides: Record<string, boolean | number | string> = {
    claim_is_for_joint_claimants: isJoint,
  };

  function emitSlots(entityKind: InputRecord["entity"], entityId: string, overrides: Record<string, boolean | number | string>): InputRecord[] {
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

  function serviceChargePaymentOverrides(): Record<string, boolean | number | string> {
    return {
      payment_is_relevant_service_charge_payment_taken_into_account_under_paragraph_8:
        hasServiceCharge,
      service_charge_payment_amount:
        monthlyServiceCharge > 0 ? monthlyServiceCharge : weeklyServiceCharge,
      service_charge_payment_period_is_month: monthlyServiceCharge > 0,
      service_charge_payment_period_is_week:
        monthlyServiceCharge === 0 && weeklyServiceCharge > 0,
      total_service_charge_payments_liable_in_12_month_period:
        monthlyServiceCharge > 0 ? 12 : weeklyServiceCharge > 0 ? 52 : 0,
    };
  }

  const inputs: InputRecord[] = [
    ...emitSlots("Family", FAMILY_ID, familyOverrides),
    ...emitSlots("Person", PRIMARY_ADULT_ID, primaryAdultOverrides),
    ...(isJoint ? emitSlots("Person", SECOND_ADULT_ID, secondAdultOverrides) : []),
    ...children.flatMap((c) => emitSlots("Person", c.id, childOverrides(c))),
    ...(hasServiceCharge
      ? emitSlots("Payment", SERVICE_CHARGE_PAYMENT_ID, serviceChargePaymentOverrides())
      : []),
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
    ...(hasServiceCharge
      ? [
          {
            name: OWNER_OCCUPIER_SERVICE_CHARGE_RELATION,
            tuple: [SERVICE_CHARGE_PAYMENT_ID, FAMILY_ID] as [string, string],
            interval,
          },
        ]
      : []),
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
    renters_housing_costs_element_calculated_under_this_part: number;
    owner_occupier_housing_costs_element_amount: number;
    housing_cost_element_under_shared_ownership: number;
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

async function precomputeHousingCosts(facts: UkUcFacts): Promise<{
  renters: number;
  ownerOccupier: number;
  sharedOwnership: number;
}> {
  const hasRent = Math.max(0, facts.monthly_rent ?? 0) > 0 || Math.max(0, facts.monthly_rent_cap ?? 0) > 0;
  const hasServiceCharge =
    Math.max(0, facts.monthly_owner_occupier_service_charge ?? 0) > 0 ||
    Math.max(0, facts.weekly_owner_occupier_service_charge ?? 0) > 0;
  if (!hasRent && !hasServiceCharge) {
    return { renters: 0, ownerOccupier: 0, sharedOwnership: 0 };
  }

  const { req } = buildRequest(facts);
  const { period } = taxYearInterval(facts.tax_year_start ?? INTERVAL_START_FALLBACK);
  const rentersId =
    "uk:regulations/uksi/2013/376/schedule/4/paragraph/22#renters_housing_costs_element_calculated_under_this_part";
  const ownerId =
    "uk:regulations/uksi/2013/376/schedule/5/paragraph/9#owner_occupier_housing_costs_element_amount";
  const sharedId =
    "uk:regulations/uksi/2013/376/26#housing_cost_element_under_shared_ownership";

  req.queries = [
    {
      entity_id: FAMILY_ID,
      period,
      outputs: [rentersId, ownerId],
    },
    {
      entity_id: PRIMARY_ADULT_ID,
      period,
      outputs: [sharedId],
    },
  ];

  const res = await runCompiled(ARTIFACT_SLUG, req);
  const familyRow = res.results[0];
  const personRow = res.results[1];
  const renters = readOutput(familyRow.outputs[rentersId])?.numeric ?? 0;
  const ownerOccupier = readOutput(familyRow.outputs[ownerId])?.numeric ?? 0;
  const reg26SharedOwnership = readOutput(personRow.outputs[sharedId])?.numeric ?? 0;
  const sharedOwnershipRequested = facts.has_shared_ownership_tenancy ?? (hasRent || hasServiceCharge);
  return {
    renters,
    ownerOccupier,
    sharedOwnership:
      reg26SharedOwnership > 0 || !sharedOwnershipRequested
        ? reg26SharedOwnership
        : renters + ownerOccupier,
  };
}

export async function computeUkUniversalCredit(facts: UkUcFacts): Promise<UkUcResult> {
  // Pass 1: get per-child responsible_child_element_included_amount (reg 24)
  // and disabled_child_additional_amount (reg 36) so we can feed them as inputs
  // to the s.10 bridge in pass 2.
  const childAmounts = await precomputeChildAmounts(facts);
  const housingCosts = await precomputeHousingCosts(facts);

  // Pass 2: build the full request, overriding bridge input slots with
  // derived values from pass 1, then query for the final award.
  const { req, children } = buildRequest(facts);
  for (const inp of req.dataset.inputs) {
    if (inp.entity !== "Person") continue;
    const m = childAmounts.get(inp.entity_id);
    if (m && inp.name === INPUT_PREFIX + "responsible_child_element_included_amount") {
      inp.value = fact(m.child, "decimal");
    } else if (m && inp.name === INPUT_PREFIX + "disabled_child_additional_amount") {
      inp.value = fact(m.disabled, "decimal");
    } else if (
      inp.entity_id === PRIMARY_ADULT_ID &&
      inp.name === INPUT_PREFIX + "housing_cost_element_under_shared_ownership"
    ) {
      inp.value = fact(housingCosts.sharedOwnership, "decimal");
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
    renters_housing_costs_element_calculated_under_this_part: housingCosts.renters,
    owner_occupier_housing_costs_element_amount: housingCosts.ownerOccupier,
    housing_cost_element_under_shared_ownership: housingCosts.sharedOwnership,
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
      { id: "uk:regulations/uksi/2013/376/26", url: "https://app.axiom-foundation.org/uk/regulation/uksi/2013/376/26" },
      { id: "uk:regulations/uksi/2013/376/schedule/4/paragraph/22", url: "https://app.axiom-foundation.org/uk/regulation/uksi/2013/376/schedule/4/paragraph/22" },
      { id: "uk:regulations/uksi/2013/376/schedule/5/paragraph/9", url: "https://app.axiom-foundation.org/uk/regulation/uksi/2013/376/schedule/5/paragraph/9" },
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
