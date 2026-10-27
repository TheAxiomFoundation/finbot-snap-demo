/**
 * Statutory amendments that an encoded module's cited text predates.
 *
 * A rule's `source` names the provision it was encoded from, and
 * fetch_citation serves that provision's corpus text. When a statute changes
 * the law before the regulation is revised, the rule's later formula version
 * applies the amended statute while the cited text still states the old
 * rule. 7 CFR 273.4 still lists refugees among the aliens eligible for SNAP;
 * from 2025-08-01 the encoded check does not, because P.L. 119-21 §10108
 * narrowed 7 U.S.C. 2015(f). Each entry names the amended provision so a
 * failed check and its citation show the law the verdict applied.
 *
 * Every field rests on corpus text (`evidence`). amendments.test.ts checks
 * each entry against the pinned catalog: the module and the amended
 * provision are both encoded, and the module's rules switch formula on
 * `encoded_from`. The link itself is curated: rulespec-us states it only in
 * prose (the 273.4 module's deferred outputs: "7 CFR 273.4(a), as amended by
 * 7 U.S.C. 2015(f)(2) effective July 4, 2025") and in the separate
 * us:statutes/7/2015/f module, not on the 273.4 rules' `source`.
 */
import type { CatalogOutput, FormulaVersion } from "./catalog";

export interface StatutoryAmendment {
  /** Legal id of the module whose cited text predates the amendment. */
  module: string;
  /** How the module is cited, e.g. "7 CFR 273.4". */
  module_citation: string;
  /** The provision as amended: an encoded module with its own corpus text. */
  provision: { legal_id: string; citation: string };
  enacted_by: string;
  /** The day the amendment took effect. */
  effective: string;
  /** The first day the module's encoded rules apply the amended law: the
   *  `effective_from` of their post-amendment formula version. Month rules
   *  select the law in force at the period's start, so this is the first
   *  month start on or after `effective`. */
  encoded_from: string;
  /** A passage the cited text keeps from before the amendment, and what it
   *  says. fetch_citation calls the text out of date only while the corpus
   *  text it served still contains `passage`. */
  superseded: { passage: string; summary: string };
  /** Corpus text behind `enacted_by`, `effective` and `provision`, quoted
   *  exactly. */
  evidence: Array<{ citation_path: string; excerpt: string }>;
}

export const STATUTORY_AMENDMENTS: readonly StatutoryAmendment[] = [
  {
    module: "us:regulations/7-cfr/273/4",
    module_citation: "7 CFR 273.4",
    provision: { legal_id: "us:statutes/7/2015/f", citation: "7 U.S.C. 2015(f)" },
    enacted_by: "P.L. 119-21, §10108",
    effective: "2025-07-04",
    encoded_from: "2025-08-01",
    superseded: {
      passage: "(B) An alien admitted as a refugee under section 207 of the INA",
      summary:
        "it still lists refugees (7 CFR 273.4(a)(6)(ii)(B)), asylees and other qualified aliens among the aliens eligible for SNAP, while the amended statute lists only U.S. citizens and nationals, lawful permanent residents, Cuban and Haitian entrants, and people lawfully residing under a Compact of Free Association",
    },
    evidence: [
      {
        citation_path: "us/guidance/usda/fns/snap-obbb-alien-eligibility-implementation-memo/page-1",
        excerpt: "Public Law 119-21, the One Big Beautiful Bill Act of 2025 (OBBB)",
      },
      {
        citation_path: "us/guidance/usda/fns/snap-obbb-alien-eligibility-implementation-memo/page-1",
        excerpt: "Section 10108 of the OBBB amends section 6(f) of the Food and Nutrition Act of 2008 (FNA)",
      },
      {
        citation_path: "us/guidance/usda/fns/snap-obbb-alien-eligibility-implementation-memo/page-3",
        excerpt:
          "Section 10108 of the OBBB was effective upon enactment, July 4, 2025. State agencies must immediately apply the new eligibility criteria to new applicants at initial certification. For households already receiving SNAP, State agencies must review household circumstances and apply these policies at recertification.",
      },
    ],
  },
];

/** The entry for a legal id's module (any `#rule` suffix ignored). */
export function amendmentForModule(legalId: string): StatutoryAmendment | undefined {
  const base = legalId.split("#")[0];
  return STATUTORY_AMENDMENTS.find((a) => a.module === base);
}

/** The formula version in force on `date` (YYYY-MM-DD), if any. */
export function formulaVersionAt(versions: readonly FormulaVersion[], date: string): FormulaVersion | undefined {
  return versions.find((v) => v.effective_from <= date && (!v.effective_to || date <= v.effective_to));
}

/** The amendment a rule applies on `date`: its module has an entry, and the
 *  formula version in force then began on or after `encoded_from`. A rule
 *  with one undated formula never changed for the amendment, so it gets
 *  none. */
export function appliedAmendment(
  rule: Pick<CatalogOutput, "id" | "versions">,
  date: string
): StatutoryAmendment | undefined {
  if (!rule.id || !rule.versions) return undefined;
  const amendment = amendmentForModule(rule.id);
  if (!amendment) return undefined;
  const version = formulaVersionAt(rule.versions, date);
  return version && version.effective_from >= amendment.encoded_from ? amendment : undefined;
}

/** The last day a rule's formula from before the amendment was in force
 *  (2025-06-30 for the 7 CFR 273.4 checks): the latest `effective_to` before
 *  `encoded_from`. */
export function earlierFormulaEnd(
  rule: Pick<CatalogOutput, "versions">,
  amendment: StatutoryAmendment
): string | undefined {
  const ends = (rule.versions ?? [])
    .flatMap((v) => (v.effective_to && v.effective_to < amendment.encoded_from ? [v.effective_to] : []))
    .sort();
  return ends.at(-1);
}

/** What a failed check or a lookup carries when its rule applies an
 *  amendment: enough to cite the amended provision without a fetch. */
export interface AmendmentRef {
  legal_id: string;
  citation: string;
  enacted_by: string;
  effective: string;
  applies_from: string;
  url: string;
  note: string;
  /** The same facts run through the rule's formula from before the
   *  amendment (the engine, for `period`). Absent when that run was not made
   *  or failed. */
  earlier?: { period: string; value: string | number | boolean | null };
  /** Whether the amendment changed this result: `earlier.value` differs from
   *  the value under the amended formula. A refugee met the 7 CFR 273.4
   *  check before P.L. 119-21 and fails it after; a lawful permanent
   *  resident short of the five-year wait fails it under both. */
  changed_outcome?: boolean;
}

export function amendmentRef(amendment: StatutoryAmendment, url: string): AmendmentRef {
  const { provision, enacted_by, effective, encoded_from, module_citation } = amendment;
  return {
    legal_id: provision.legal_id,
    citation: provision.citation,
    enacted_by,
    effective,
    applies_from: encoded_from,
    url,
    note:
      `For periods from ${encoded_from} this ${module_citation} rule applies ${provision.citation} as amended by ` +
      `${enacted_by} (effective ${effective}). Cite the amended provision as the law this result applied; ` +
      `fetch_citation on ${amendment.module} returns both texts.`,
  };
}

/** `ref` with what the formula from before the amendment gave for the same
 *  facts, and whether that differs from `now`. */
export function withEarlierOutcome(
  ref: AmendmentRef,
  now: string | number | boolean,
  earlier: { period: string; value: string | number | boolean }
): AmendmentRef {
  const changed = earlier.value !== now;
  const under = `Under the formula in force before the amendment (run for ${earlier.period}) the same facts`;
  const sentence = !changed
    ? `${under} give the same result, so the amendment did not change it.`
    : now === "not_holds" && earlier.value === "holds"
      ? `${under} met this check, so the amendment is why it fails now.`
      : now === "holds" && earlier.value === "not_holds"
        ? `${under} failed this check, so the amendment is why it holds now.`
        : `${under} gave ${earlier.value}, so the amendment changed this result.`;
  return { ...ref, earlier, changed_outcome: changed, note: `${ref.note} ${sentence}` };
}
