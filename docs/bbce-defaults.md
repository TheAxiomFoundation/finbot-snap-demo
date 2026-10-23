BBCE input defaults and safety checks

Engine: ffd82132; release: program-artifacts-09d8d50a9add. Period: 2026-09; shelter $1,800; unearned $0. The build lane checkpointed each result locally; the committed engine regression and property scripts cover the supported default path.

| State | Size | Encoded 100% FPL/month | Gross income/FPL | Before flag | After flag | After amount |
|---|---:|---:|---:|---|---|---:|
| us-ca-snap | 1 | 1305 | 145% | not_holds / $0 | holds | $129 |
| us-ca-snap | 1 | 1305 | 175% | not_holds / $0 | holds | $35 |
| us-ca-snap | 1 | 1305 | 195% | not_holds / $0 | holds | $24 |
| us-ca-snap | 1 | 1305 | 207% | not_holds / $0 | not_holds | $0 |
| us-ca-snap | 1 | 1305 | 307% | not_holds / $0 | not_holds | $0 |
| us-ca-snap | 3 | 2221 | 145% | not_holds / $0 | holds | $260 |
| us-ca-snap | 3 | 2221 | 175% | not_holds / $0 | holds | $19 |
| us-ca-snap | 3 | 2221 | 195% | not_holds / $0 | not_holds | $0 |
| us-ca-snap | 3 | 2221 | 207% | not_holds / $0 | not_holds | $0 |
| us-ca-snap | 3 | 2221 | 307% | not_holds / $0 | not_holds | $0 |
| us-co-snap | 1 | 1305 | 145% | not_holds / $0 | holds | $129 |
| us-co-snap | 1 | 1305 | 175% | not_holds / $0 | holds | $35 |
| us-co-snap | 1 | 1305 | 195% | not_holds / $0 | holds | $24 |
| us-co-snap | 1 | 1305 | 207% | not_holds / $0 | not_holds | $0 |
| us-co-snap | 1 | 1305 | 307% | not_holds / $0 | not_holds | $0 |
| us-co-snap | 3 | 2221 | 145% | not_holds / $0 | holds | $298 |
| us-co-snap | 3 | 2221 | 175% | not_holds / $0 | holds | $137 |
| us-co-snap | 3 | 2221 | 195% | not_holds / $0 | holds | $31 |
| us-co-snap | 3 | 2221 | 207% | not_holds / $0 | not_holds | $0 |
| us-co-snap | 3 | 2221 | 307% | not_holds / $0 | not_holds | $0 |

California's default retains the exclusions in the BBCE probes. All 11 tested exclusions retained denial at 145%: noncitizen, student, SSN refusal, general work noncompliance, ABAWD with 4 countable months, IPV, head work sanction, monthly reporting failure, fleeing felon, entire-household workfare disqualification, nonexempt institution. California 3-person 195% at $1,800 shelter has zero benefit and snap_eligible=not_holds through its categorical zero-benefit denial; a blanket eligible invariant regardless of deductions is not valid.

Colorado's default is withheld and both expanded/basic categorical flags are locked in the assistant. At 145% a 1-person household with member_disqualified_for_snap_ipv_at_application=true yields $129/holds with snap_expanded_categorical_eligible=true even though expanded_categorical_eligibility_barred=holds and expanded_categorical_eligibility_household=not_holds. The assistant flag directly feeds passes_gross_income_test/passes_net_income_test and ignores that encoded bar. At 50% the same IPV input produces $298/holds with BOTH flag values: there is a preexisting composition omission, and the proposed flag newly enables the BBCE path for this barred household. No TypeScript eligibility reimplementation was added.

The artifact rule `us-co:regulations/10-ccr-2506-1/4.206#expanded_categorical_eligibility_barred` reads `member_disqualified_for_snap_ipv_at_application` and `member_convicted_of_drug_related_felony_where_snap_benefits_used_to_purchase_drugs_at_application`. It is not reachable from published `snap_eligible`.

Primary legal support: [Colorado 10 CCR 2506-1, 4.206(C)(2)(c), page 36](https://www.sos.state.co.us/CCR/GenerateRulePdf.do?ruleVersionId=11117#page=36) excludes ECE where any member is disqualified for a SNAP IPV. [7 CFR 273.2(j)(2)(vii)(A)](https://www.ecfr.gov/current/title-7/subtitle-B/chapter-II/subchapter-C/part-273/section-273.2) also prohibits categorical eligibility for a household with an IPV-disqualified member. Source inspected 2026-10-07.

Core member-scope CO noncitizen, student, SSN refusal, general work noncompliance, and ABAWD probes with 4 countable months remain denied under both flags. CO auxiliary sanctioned_abawd, person_determined_ineligible_non_citizen_for_snap and disqualified_or_sanctioned_member_count inputs do not affect published results; do not mistake their unchanged result for proof of exclusion coverage. CA generic standard-income path also accepts IPV/head work sanction/monthly reporting/fleeing/workfare/institution inputs at 50% before and after the flag; the new CA BBCE path blocks these at 145%. These preexisting exclusions need upstream composition review.

The existing ABAWD artifact uses >3 countable months, so 3-month probes held and 4-month probes failed; this artifact boundary is not fixed by input plumbing.

New York's earned-income companion input was checked for 1 and 3 people, 2026-10: 145% with earnings holds; 160% with earnings denies; a dependent-care or elderly path at 160% holds. Derived companion appears in applied.derived_facts and notes for Assumptions.

## Florida assistance-group size fix

Release `program-artifacts-16a667719019` (engine `98af0dce`, v0.1.2) derives `assistance_group_size` from `household_size` instead of exposing a separate input defaulting to 1. Florida's Appendix A-1 outputs now use the household's size. For `household_size=3`, the encoded FY2026 table gives:

| Florida A-1 output | Previous release, size defaulted to 1 | New release, size 3 |
|---|---:|---:|
| Monthly 200% gross income limit | $2,610 | $4,442 |
| Monthly 130% gross income limit | $1,696 | $2,888 |
| Monthly 100% net income limit | $1,305 | $2,221 |
| Maximum food assistance benefit | $298 | $785 |

Florida BBCE remains unencoded (rulespec-us#1183, bug 1). The size fix does not add Florida's BBCE path to `snap_eligible` or `snap_benefit`: the income composition still uses `snap_standard_income_eligible`. Keep the Florida disclosure because a $0 for a household above the federal 130% gross income limit but within the state's higher BBCE limit is not a determination; it may still qualify.

## Dollar gap against PolicyEngine, traced

The earlier comparison (3 people, $3,300 a month in earnings, $1,800 shelter) showed Axiom $231 or $278 against PolicyEngine $261.70 or $316.70. The trace (`scripts/trace-snap-gap.ts`, `scripts/trace-pe-gap.py`; outputs in `docs/bbce-evidence/`) finds two input differences and no rule disagreement:

| | Utility allowance | Excess shelter deduction | Net income | Benefit |
|---|---:|---:|---:|---:|
| Axiom CA, Sep 2026, no heating/cooling cost (CA default) | $0 | $585 | $1,846 | $231 |
| Axiom CA, Sep 2026, heating/cooling cost | $663 | $744 (cap) | $1,687 | $278 |
| PolicyEngine 1.822.5 CA, Sep 2026 (either heating input) | $663 | $744 (cap) | $1,687 | $278 |
| Axiom CO, Sep 2026, heating/cooling default true; BBCE input forced on for the trace (the chatbot itself returns $0 for Colorado) | $594 | $744 (cap) | $1,687 | $278 |
| PolicyEngine 1.822.5 CA or CO, Oct 2026 | $663 / $594 | $770.30 | $1,653 | $316.72 |

1. **Utility allowance.** Axiom applies California's allowance only when the household has heating or cooling costs separate from rent; California's input defaults to false, Colorado's to true. PolicyEngine 1.822.5 applied the allowance regardless of the heating input. With the same heating fact, the two agree to the dollar.
2. **Standards year.** For October 2026, PolicyEngine 1.822.5 projected FY2027 values (maximum $812.72); the pinned Axiom release has FY2026 standards only (maximum $785), and FNS's published FY2027 maximum for 3 people is $808.

So the chatbot's answers depend on the household's heating fact, which the BBCE starter states explicitly, and on the FY2027 standards, which are not yet encoded.

## South Carolina 4.1(D) (Family Independence Information and Referral)

SNAP Manual Vol 73 (October 2026) 4.1(D) extends categorical eligibility to "all households in which any member receives, or is authorized to receive" Family Independence Information and Referral Services, which "are provided to households whose income falls at or below 130% of the Federal Poverty Level (FPL)". These households "are not subject to gross or net income limits". 4.4 screens every applicant for the services before the SNAP determination, and 4.2's EXCEPTION makes them available to households with an ineligible or disqualified member. The USDA FNS BBCE chart (June 2026) lists South Carolina as "All households are eligible (pamphlet)", no asset limit, 130%. [Manual, page 43](https://dss.sc.gov/media/llodk0kb/snap-manual-volume-73.pdf#page=43).

The encoding (`expanded_categorically_eligible_household`) needs two facts, `any_member_receives_or_authorized_family_independence_information_referral_services` and `household_meets_non_financial_snap_eligibility_criteria`, and tests `household_gross_income <= 1.3 * federal_poverty_level_for_household`, with both amounts as inputs. All four defaulted to false or 0. With the two facts set, `0 <= 0` held at any income; with gross income set too, the test failed at any income.

The overlay now derives both amounts from the program's own outputs (`derived_inputs`: `snap_net_income_limit_100_percent_fpl_48_states_dc` and `snap_gross_monthly_income`, read in one fast engine call before the compute and reported in `applied.derived_facts`) and defaults both facts to true. `snap_eligible` still requires `snap_eligible_core`, the per-member citizenship, SSN, work and student checks.

Engine, release program-artifacts-16a667719019, period 2026-09, unearned income only, no shelter cost; PolicyEngine 1.808.0 for the same month:

| Household | 130% / 100% FPL (FY2026) | Before | After | PolicyEngine |
|---|---:|---:|---:|---:|
| 2 people, $2,000 | $2,292 / $1,763 | $0 | $24 | $24.00 |
| 4 people, $3,400 | $3,483 / $2,680 | $0 | $40 | $40.90 |
| 6 people, $4,600 | $4,675 / $3,596 | $0 | $130 | $130.70 |
| 2 people, $3,000 | $2,292 / $1,763 | $0 | $0 | $0 |
| 1 person, $4,004 earned (307%), both facts set | $1,696 / $1,305 | holds, $24 | not_holds, $0 | — |
