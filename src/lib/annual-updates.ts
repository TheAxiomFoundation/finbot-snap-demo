/**
 * Annual-update coverage: flags computes whose period is past the date an
 * annually reissued parameter was due for its next version.
 *
 * Some parameters are reissued every year — the SNAP cost-of-living
 * adjustment each October 1, Maine's TANF grant table. When the pinned
 * release doesn't carry the new year's version yet, the engine keeps
 * evaluating the last one, and a "what do I get now?" answer comes back
 * confident and outdated. The catalog generator classifies these parameters
 * from the artifacts themselves (`classifyAnnualParameter`) and records when
 * each was due; the request builder turns a period on or after that date into
 * a user-facing disclosure plus a WARNING the model must act on.
 *
 * The default period is deliberately NOT capped at the last covered month:
 * a cap would only move unspecified periods, leave an explicit "October 2026"
 * just as silently stale, and relabel a "now" answer with a month the user
 * never asked about. Disclosing keeps the period honest and covers both.
 */
import type { CatalogAnnualUpdate, CatalogOutput, CatalogProgram } from "./catalog";

/** Source-document marker naming the fiscal year a parameter was issued for,
 *  e.g. `us:policies/usda/snap/fy-2026-cola/maximum-allotments`. */
const FISCAL_YEAR_SOURCE = /(?:^|[/_-])fy-?(\d{4})(?=$|[/_-])/i;

/** Unbroken yearly steps (same month-day, exactly one year apart, ending at
 *  the latest version) before a version history counts as an annual cycle.
 *  Three separates indexed tables (Maine TANF: every October 1, 2021–2025)
 *  from short statutory phase-ins that stop (Illinois SCRETD's income limit:
 *  2025, 2026, then "2027 and thereafter"). */
export const MIN_ANNUAL_STEPS = 3;

export interface AnnualParameter {
  basis: CatalogAnnualUpdate["basis"];
  last_effective_from: string;
  due: string;
  fiscal_year?: number;
  /** Source document: the legal id without its `#fragment`. */
  source: string | null;
}

/** Shift a YYYY-MM-DD date by whole years (Feb 29 clamps to Feb 28). */
export function addYears(date: string, years: number): string {
  const year = String(Number(date.slice(0, 4)) + years).padStart(4, "0");
  const monthDay = date.slice(4);
  return `${year}${monthDay === "-02-29" ? "-02-28" : monthDay}`;
}

/** Federal fiscal year containing a date (FY2026 = 2025-10-01 … 2026-09-30). */
export function federalFiscalYear(date: string): number {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 10 ? year + 1 : year;
}

/** Classify one compiled parameter. Annual when its source names a fiscal
 *  year, or when its versions recur yearly; either way the next version is
 *  due one year after the latest one took effect. */
export function classifyAnnualParameter(param: {
  id?: string | null;
  versions?: Array<{ effective_from?: string | null }>;
}): AnnualParameter | null {
  const dates = [...new Set((param.versions ?? []).map((v) => v.effective_from).filter((d): d is string => !!d))].sort();
  if (dates.length === 0) return null;
  const last = dates[dates.length - 1];
  const due = addYears(last, 1);
  const source = param.id ? param.id.split("#")[0] : null;

  const marker = source?.match(FISCAL_YEAR_SOURCE);
  if (marker) {
    const fiscalYear = Number(marker[1]);
    return {
      basis: "fiscal_year_source",
      last_effective_from: last,
      due,
      // Label only when the marker is the federal fiscal year of the latest
      // version: a state fiscal year (July–June), or a newer version added
      // under the old id, would otherwise mislabel the standards in use.
      ...(federalFiscalYear(last) === fiscalYear && { fiscal_year: fiscalYear }),
      source,
    };
  }

  let steps = 0;
  for (let i = dates.length - 1; i > 0 && addYears(dates[i - 1], 1) === dates[i]; i--) steps++;
  return steps >= MIN_ANNUAL_STEPS ? { basis: "annual_versions", last_effective_from: last, due, source } : null;
}

/** Group classified parameters by when they fall due, for the catalog. */
export function groupAnnualUpdates(params: Array<AnnualParameter & { name: string }>): CatalogAnnualUpdate[] {
  const groups = new Map<string, CatalogAnnualUpdate>();
  for (const param of params) {
    const key = [param.due, param.last_effective_from, param.basis, param.fiscal_year ?? ""].join("|");
    let group = groups.get(key);
    if (!group) {
      group = {
        due: param.due,
        last_effective_from: param.last_effective_from,
        basis: param.basis,
        ...(param.fiscal_year !== undefined && { fiscal_year: param.fiscal_year }),
        sources: [],
        parameters: [],
      };
      groups.set(key, group);
    }
    if (param.source && !group.sources.includes(param.source)) group.sources.push(param.source);
    group.parameters.push(param.name);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, sources: g.sources.sort(), parameters: g.parameters.sort() }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.basis.localeCompare(b.basis));
}

/** Annual updates a request has run past: the program's groups due on or
 *  before the latest period start among queried outputs that actually reach
 *  an overdue annual parameter. Outputs that don't depend on one (a fixed
 *  statutory rate, a tax computed off January-indexed values) never trigger. */
export function overdueAnnualUpdates(
  program: Pick<CatalogProgram, "annual_updates">,
  queried: Array<{ output: Pick<CatalogOutput, "annual_update_due">; periodStart: string }>
): CatalogAnnualUpdate[] {
  let asOf: string | null = null;
  for (const { output, periodStart } of queried) {
    if (output.annual_update_due && output.annual_update_due <= periodStart && (!asOf || periodStart > asOf)) {
      asOf = periodStart;
    }
  }
  if (!asOf) return [];
  return (program.annual_updates ?? []).filter((u) => u.due <= asOf);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-10-01" → "October 1, 2026". */
export function formatDate(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${Number(date.slice(0, 4))}`;
}

function standardsInUse(update: CatalogAnnualUpdate): string {
  return update.fiscal_year
    ? `FY${update.fiscal_year} standards`
    : `the standards in effect from ${formatDate(update.last_effective_from)}`;
}

function missingUpdate(update: CatalogAnnualUpdate): string {
  return update.fiscal_year
    ? `the FY${update.fiscal_year + 1} update due ${formatDate(update.due)}`
    : `the annual update due ${formatDate(update.due)}`;
}

/** User-facing limitation for the tool card and program pages. */
export function annualUpdateDisclosure(program: Pick<CatalogProgram, "display_name">, update: CatalogAnnualUpdate): string {
  return `${program.display_name} figures use ${standardsInUse(update)}; ${missingUpdate(update)} is not encoded yet, so amounts from that date may differ from current law.`;
}

/** Model-facing instruction carried in the applied report's notes. */
export function annualUpdateWarning(update: CatalogAnnualUpdate, periodLabel: string): string {
  const fy = update.fiscal_year ? ` (FY${update.fiscal_year})` : "";
  const example = update.fiscal_year
    ? `under FY${update.fiscal_year} standards`
    : `under the standards in effect from ${formatDate(update.last_effective_from)}`;
  return (
    `WARNING: period ${periodLabel} is on or after ${update.due}, when ${update.parameters.length} annually reissued parameter(s) in this program were due for a new version (${update.sources.join(", ")}). ` +
    `This release still evaluates the version in effect from ${update.last_effective_from}${fy}, so these amounts are NOT confirmed current law for ${periodLabel}. ` +
    `Keep the computed amounts, but qualify the headline (e.g. "$X/month ${example}") and state once that ${missingUpdate(update)} is not encoded yet, so the current amount may differ. ` +
    `Never substitute newer values from memory, and do not change the period to avoid this warning.`
  );
}

/** "2026-10" → "2026-10-01", "2026" → "2026-01-01". */
export function periodStartDate(period: string): string {
  return /^\d{4}$/.test(period) ? `${period}-01-01` : `${period.slice(0, 7)}-01`;
}

/** The headline output's overdue annual updates as of a date — program-level
 *  notices for describe_program, the program pages, and the coverage digest. */
export function overdueForHeadline(program: CatalogProgram, date: string): CatalogAnnualUpdate[] {
  const primary = program.outputs.find((o) => o.name === program.primary_output);
  return primary ? overdueAnnualUpdates(program, [{ output: primary, periodStart: date }]) : [];
}

export function annualUpdateNoticesAt(program: CatalogProgram, date: string): string[] {
  return overdueForHeadline(program, date).map((update) => annualUpdateDisclosure(program, update));
}

/** Compact marker for the system-prompt coverage digest. */
export function annualUpdateDigestNote(program: CatalogProgram, date: string): string {
  return overdueForHeadline(program, date)
    .map((u) => `; ${digestLabel(u)}`)
    .join("");
}

function digestLabel(update: CatalogAnnualUpdate): string {
  return update.fiscal_year
    ? `FY${update.fiscal_year} standards — FY${update.fiscal_year + 1} update due ${update.due} not encoded`
    : `standards from ${update.last_effective_from} — annual update due ${update.due} not encoded`;
}
