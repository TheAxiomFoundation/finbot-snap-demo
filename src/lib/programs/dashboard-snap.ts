import type { CoSnapFacts } from "./co-snap";
import { legalIdToUrl } from "./co-snap";

type SnapJurisdiction = "ca" | "ny";
type DashboardScalar = number | string | boolean | null;
type SnapJudgment = "holds" | "not_holds";

interface DashboardOutput {
  legalId: string;
  value: DashboardScalar;
  dtype?: string | null;
}

interface DashboardResponse {
  outputs?: DashboardOutput[];
  traces?: Record<string, { source?: string | null }>;
  warnings?: string[];
  mode?: string;
}

interface DashboardConfig {
  repo: string;
  prefix: "us-ca" | "us-ny";
  displayName: string;
  programName: string;
}

const CONFIG: Record<SnapJurisdiction, DashboardConfig> = {
  ca: {
    repo: "rules-us-ca",
    prefix: "us-ca",
    displayName: "California SNAP",
    programName: "California SNAP FY 2026",
  },
  ny: {
    repo: "rules-us-ny",
    prefix: "us-ny",
    displayName: "New York SNAP",
    programName: "New York SNAP FY 2026",
  },
};

const PROGRAM_PATH = "programs/snap/fy-2026.yaml";
const PROGRAM_FRAGMENT = "programs/snap/fy-2026";
const RELATION_MEMBER_OF_HOUSEHOLD =
  "us:statutes/7/2012/j#relation.member_of_household";

const FEDERAL_OUTPUTS = {
  snap_resource_eligible: "us:regulations/7-cfr/273/8#snap_resource_eligible",
  snap_income_eligible: "us:regulations/7-cfr/273/9#snap_standard_income_eligible",
  snap_maximum_allotment:
    "us:policies/usda/snap/fy-2026-cola/maximum-allotments#snap_maximum_allotment",
  snap_net_income: "us:statutes/7/2014/e/6/A#snap_net_income",
  snap_standard_deduction:
    "us:policies/usda/snap/fy-2026-cola/deductions#snap_standard_deduction",
  snap_earned_income_deduction:
    "us:statutes/7/2014/e/2#snap_earned_income_deduction",
  excess_shelter_deduction:
    "us:regulations/7-cfr/273/10#snap_excess_shelter_deduction_for_net_income",
} as const;

function stateOutputIds(prefix: DashboardConfig["prefix"]) {
  return {
    snap_eligible: `${prefix}:${PROGRAM_FRAGMENT}#snap_eligible`,
    snap_benefit: `${prefix}:${PROGRAM_FRAGMENT}#snap_benefit`,
    gross_income: `${prefix}:${PROGRAM_FRAGMENT}#snap_gross_monthly_income`,
    household_income: `${prefix}:${PROGRAM_FRAGMENT}#snap_monthly_household_income`,
    shelter_costs: `${prefix}:${PROGRAM_FRAGMENT}#snap_total_allowable_shelter_expenses`,
  };
}

const SURFACE_NAMES = [
  "snap_eligible",
  "snap_income_eligible",
  "snap_resource_eligible",
  "snap_regular_month_allotment",
  "snap_benefit",
  "snap_allotment",
  "snap_maximum_allotment",
  "gross_income",
  "snap_net_income",
  "snap_standard_utility_allowance",
  "snap_standard_deduction",
  "snap_earned_income_deduction",
  "excess_shelter_deduction",
  "shelter_costs",
] as const;

type SurfaceName = (typeof SURFACE_NAMES)[number];

export interface DashboardSnapResult {
  period: string;
  household_size: number;
  program: string;
  outputs: Record<SurfaceName, number | SnapJudgment>;
  applied_facts: CoSnapFacts;
  citations: Array<{ id: string; url: string }>;
  warnings: string[];
}

export async function computeDashboardSnap(
  jurisdiction: SnapJurisdiction,
  facts: CoSnapFacts,
): Promise<DashboardSnapResult> {
  const config = CONFIG[jurisdiction];
  const ids = stateOutputIds(config.prefix);
  const outputsByName = {
    ...ids,
    ...FEDERAL_OUTPUTS,
  };
  const response = await runDashboardCompute(
    config,
    facts,
    Object.values(outputsByName),
  );
  return shapeDashboardResult(config, facts, response, outputsByName);
}

export async function lookupDashboardSnapValue(
  legalId: string,
  facts: CoSnapFacts = {},
): Promise<{
  legal_id: string;
  name: string;
  entity: "Household";
  dtype: string | null;
  unit: string | null;
  semantics: "scalar" | "judgment" | string;
  value: number | SnapJudgment | null;
  source: string | null;
  url: string;
  applied_facts: CoSnapFacts;
}> {
  const jurisdiction = jurisdictionForLegalId(legalId);
  if (!jurisdiction) {
    throw new Error(`unsupported CA/NY legal_id: ${legalId}`);
  }

  const config = CONFIG[jurisdiction];
  const response = await runDashboardCompute(config, facts, [legalId]);
  const output = response.outputs?.find((candidate) => candidate.legalId === legalId);
  const name = legalId.split("#").pop() ?? legalId;
  const value = normalizeValue(output?.value);
  return {
    legal_id: legalId,
    name,
    entity: "Household",
    dtype: output?.dtype ?? null,
    unit: typeof value === "number" ? "USD" : null,
    semantics: isJudgment(value) ? "judgment" : "scalar",
    value,
    source: response.traces?.[legalId]?.source ?? null,
    url: legalIdToUrl(legalId),
    applied_facts: resolveFacts(facts),
  };
}

export function isDashboardSnapLegalId(legalId: string): boolean {
  return jurisdictionForLegalId(legalId) !== null;
}

async function runDashboardCompute(
  config: DashboardConfig,
  facts: CoSnapFacts,
  queriedOutputs: string[],
): Promise<DashboardResponse> {
  const response = await fetch(`${dashboardComputeUrl()}/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      program: {
        repo: config.repo,
        path: PROGRAM_PATH,
        displayName: config.programName,
      },
      period: { kind: "month", start: `${(facts.period ?? "2026-01")}-01` },
      inputs: buildInputs(config.prefix, facts),
      relations: buildRelations(facts),
      queried_outputs: queriedOutputs,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `dashboard compute failed (${response.status}): ${await response.text()}`
    );
  }
  return (await response.json()) as DashboardResponse;
}

function buildInputs(
  prefix: DashboardConfig["prefix"],
  facts: CoSnapFacts,
): Record<string, DashboardScalar> {
  const size = householdSize(facts);
  const inputs: Record<string, DashboardScalar> = {
    "us:regulations/7-cfr/273/3#input.household_lives_in_application_state": true,
    "us:regulations/7-cfr/273/3#input.household_in_project_area_solely_for_vacation": false,
    "us:regulations/7-cfr/273/3#input.household_contains_individual_participating_in_more_than_one_household_or_project_area":
      false,
    "us:regulations/7-cfr/273/8#input.snap_countable_financial_resources":
      facts.liquid_resources ?? 0,
    "us:policies/usda/snap/fy-2026-cola/deductions#input.household_size": size,
    "us:policies/usda/snap/fy-2026-cola/maximum-allotments#input.household_size": size,
    "us:policies/usda/snap/fy-2026-cola/income-eligibility-standards#input.household_size":
      size,
  };

  inputs[`${prefix}:${PROGRAM_FRAGMENT}#input.snap_gross_monthly_earned_income`] =
    facts.monthly_earnings_per_adult ?? 0;
  inputs[`${prefix}:${PROGRAM_FRAGMENT}#input.snap_total_monthly_unearned_income`] =
    facts.monthly_unearned_income ?? 0;
  inputs[`${prefix}:${PROGRAM_FRAGMENT}#input.household_shelter_costs_incurred`] =
    facts.monthly_shelter_costs ?? 0;

  return inputs;
}

function buildRelations(facts: CoSnapFacts): Record<string, Array<Record<string, DashboardScalar>>> {
  const members = Array.from({ length: householdSize(facts) }, (_, index) => {
    const isPrimary = index === 0;
    return {
      "us:regulations/7-cfr/273/4#input.member_is_us_citizen": isPrimary
        ? facts.primary_member_is_us_citizen ?? true
        : true,
      "us:regulations/7-cfr/273/4#input.member_is_us_noncitizen_national": false,
      "us:regulations/7-cfr/273/6#input.member_refused_or_failed_to_provide_or_apply_for_ssn":
        false,
      "us:regulations/7-cfr/273/7#input.member_age": isPrimary
        ? facts.oldest_member_age ?? 30
        : 30,
      "us:statutes/7/2012/j#input.snap_member_is_elderly_or_disabled":
        isPrimary ? facts.any_member_elderly_or_disabled ?? false : false,
    };
  });
  return { [RELATION_MEMBER_OF_HOUSEHOLD]: members };
}

function shapeDashboardResult(
  config: DashboardConfig,
  facts: CoSnapFacts,
  response: DashboardResponse,
  outputsByName: Record<string, string>,
): DashboardSnapResult {
  const byId = new Map((response.outputs ?? []).map((output) => [output.legalId, output]));
  const surface: Partial<Record<SurfaceName, number | SnapJudgment>> = {};
  for (const name of SURFACE_NAMES) {
    const id =
      name === "snap_regular_month_allotment" || name === "snap_allotment"
        ? outputsByName.snap_benefit
        : outputsByName[name];
    const value = normalizeValue(id ? byId.get(id)?.value : undefined);
    surface[name] = value ?? defaultForSurface(name);
  }

  return {
    period: facts.period ?? "2026-01",
    household_size: householdSize(facts),
    program: config.displayName,
    outputs: surface as Record<SurfaceName, number | SnapJudgment>,
    applied_facts: resolveFacts(facts),
    citations: citationsFor(response.outputs ?? []),
    warnings: response.warnings ?? [],
  };
}

function householdSize(facts: CoSnapFacts): number {
  return Math.max(1, Math.floor(facts.household_size ?? 1));
}

function resolveFacts(facts: CoSnapFacts): CoSnapFacts {
  return {
    period: facts.period ?? "2026-01",
    household_size: householdSize(facts),
    ...facts,
  };
}

function normalizeValue(value: unknown): number | SnapJudgment | null {
  if (typeof value === "number") return value;
  if (value === "holds" || value === "not_holds") return value;
  if (typeof value === "boolean") return value ? "holds" : "not_holds";
  return null;
}

function isJudgment(value: unknown): value is SnapJudgment {
  return value === "holds" || value === "not_holds";
}

function defaultForSurface(name: SurfaceName): number | SnapJudgment {
  return name.endsWith("_eligible") ? "not_holds" : 0;
}

function citationsFor(outputs: DashboardOutput[]): Array<{ id: string; url: string }> {
  const seen = new Set<string>();
  const citations: Array<{ id: string; url: string }> = [];
  for (const output of outputs) {
    const id = output.legalId.split("#")[0];
    if (!id.includes(":") || seen.has(id)) continue;
    seen.add(id);
    citations.push({ id, url: legalIdToUrl(id) });
  }
  return citations;
}

function jurisdictionForLegalId(legalId: string): SnapJurisdiction | null {
  if (legalId.startsWith("us-ca:")) return "ca";
  if (legalId.startsWith("us-ny:")) return "ny";
  return null;
}

function dashboardComputeUrl(): string {
  return (
    process.env.DASHBOARD_COMPUTE_URL ??
    process.env.NEXT_PUBLIC_DASHBOARD_COMPUTE_URL ??
    "https://policyengine--dashboard-builder-compute.modal.run"
  ).replace(/\/+$/, "");
}
