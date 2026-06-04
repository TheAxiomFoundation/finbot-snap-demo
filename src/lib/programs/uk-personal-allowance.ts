/**
 * UK personal allowance (Income Tax Act 2007 s.35) — typed user-facing fact
 * contract bound to the compiled axiom-rules-engine artifact.
 *
 * Simpler than the SNAP adapters: one Person entity, three inputs, one
 * surface output. No household relations.
 */
import {
  type ExecutionRequest,
  type ExecutionResponse,
  type InputRecord,
  fact,
  readOutput,
  runCompiled,
  taxYearInterval,
} from "../engine";
import { legalIdToUrl } from "../legal-links";
import { UK_PERSONAL_ALLOWANCE_BASE } from "./uk-personal-allowance-base";

const ARTIFACT_SLUG = "uk-personal-allowance";
const PERSON_ID = "p1";

// The engine resolves `<legal-id>#input.<NAME>` references; the prefix is
// irrelevant for resolution but we pick one that matches the source statute.
const INPUT_PREFIX = "uk:statutes/ukpga/2007/3/35#input.";

export interface UkPersonalAllowanceFacts {
  /** Calendar year the UK tax year *starts*. Default 2025 for tax year 2025-26. */
  tax_year_start?: number;
  /** The taxpayer's adjusted net income for the tax year, in £. Drives the £100k taper. */
  adjusted_net_income?: number;
  /** Whether the individual has claimed the allowance. Defaults true. */
  individual_makes_claim?: boolean;
  /** UK-residency / eligibility under s.56 of the Income Tax Act 2007. Defaults true. */
  meets_section_56_requirements?: boolean;
}

const FRIENDLY_TO_SLOT: Record<keyof UkPersonalAllowanceFacts, string | null> = {
  tax_year_start: null,
  adjusted_net_income: "adjusted_net_income",
  individual_makes_claim: "individual_makes_claim",
  meets_section_56_requirements: "individual_meets_requirements_under_section_56",
};

function buildRequest(facts: UkPersonalAllowanceFacts): ExecutionRequest {
  const taxYearStart = facts.tax_year_start ?? 2025;
  const { interval, period } = taxYearInterval(taxYearStart);

  const personInputs: InputRecord[] = UK_PERSONAL_ALLOWANCE_BASE.person_inputs.map((slot) => {
    let value: boolean | number | string = slot.default;
    // Find the friendly key that maps to this slot and read it from facts.
    const friendlyKey = (Object.keys(FRIENDLY_TO_SLOT) as Array<keyof UkPersonalAllowanceFacts>)
      .find((k) => FRIENDLY_TO_SLOT[k] === slot.name);
    if (friendlyKey && facts[friendlyKey] !== undefined) {
      value = facts[friendlyKey] as boolean | number | string;
    }
    return {
      name: INPUT_PREFIX + slot.name,
      entity: "Person",
      entity_id: PERSON_ID,
      interval,
      value: fact(value, slot.dtype as "bool" | "decimal" | "integer" | "date" | "text"),
    };
  });

  return {
    mode: "fast",
    dataset: { inputs: personInputs, relations: [] },
    queries: [
      {
        entity_id: PERSON_ID,
        period,
        outputs: Object.values(UK_PERSONAL_ALLOWANCE_BASE.outputs_by_name),
      },
    ],
  };
}

export interface UkPersonalAllowanceResult {
  /** Headline output: personal allowance in £ after the £100k taper. */
  personal_allowance: number | null;
  inputs_used: UkPersonalAllowanceFacts;
  tax_year: string;
  citations: Array<{ id: string; url: string }>;
  raw: ExecutionResponse;
}

export async function computeUkPersonalAllowance(
  facts: UkPersonalAllowanceFacts
): Promise<UkPersonalAllowanceResult> {
  const req = buildRequest(facts);
  const res = await runCompiled(ARTIFACT_SLUG, req);
  const result = res.results[0];
  const allowanceOut = result?.outputs[UK_PERSONAL_ALLOWANCE_BASE.outputs_by_name.personal_allowance];
  const allowance = allowanceOut ? readOutput(allowanceOut).numeric ?? null : null;
  const startYear = facts.tax_year_start ?? 2025;
  return {
    personal_allowance: allowance,
    inputs_used: {
      tax_year_start: startYear,
      adjusted_net_income: facts.adjusted_net_income ?? 0,
      individual_makes_claim: facts.individual_makes_claim ?? true,
      meets_section_56_requirements: facts.meets_section_56_requirements ?? true,
    },
    tax_year: `${startYear}-${(startYear + 1).toString().slice(2)}`,
    citations: [
      {
        id: "uk:statutes/ukpga/2007/3/35",
        url: legalIdToUrl("uk:statutes/ukpga/2007/3/35"),
      },
    ],
    raw: res,
  };
}

/** True if the legal_id is within the UK personal-allowance program. */
export function isUkPersonalAllowanceLegalId(legalId: string): boolean {
  return legalId.startsWith("uk:statutes/ukpga/2007/3/35#") || legalId.startsWith("uk:statutes/ukpga/2007/3/23#");
}
