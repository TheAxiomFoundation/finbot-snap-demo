/** Gate scan: no yes/no input the assistant can set, alone or together with
 * the others one judgment needs, may make a SNAP household at 307% of the
 * poverty line eligible, except inputs recording actual receipt of TANF, SSI
 * or public assistance (categorical eligibility that applies at any income)
 * and recorded known defects.
 *
 * Runs every non-auxiliary bool input of every SNAP program through the
 * assistant's own tool path (tools.compute), flipped from its default, for a
 * 1-person citizen household earning 307% of the 2025 guideline. Then runs
 * each group of bool inputs that one judgment's `requires`/`requires_any`
 * needs together (requirementGroups), all set in one compute: us-sc-snap
 * 4.1(D) categorical eligibility held at 307% only with two facts set
 * together, which no single flip shows. Blocked inputs must come back as
 * not_settable_input errors. Needs the engine (AXIOM_ENGINE_URL, or
 * AXIOM_RULES_ENGINE_BINARY + AXIOM_ARTIFACTS_DIR).
 */
import { getCatalog, slotDefaultAt, type CatalogInputSlot, type CatalogProgram, type Requirement } from "../src/lib/catalog";
import { ASSISTANT_UNSETTABLE_INPUTS } from "../src/lib/request-builder";
import { tools } from "../src/lib/tools";
import { checkpoint, CHECKPOINT_DIR, skipWithoutEngine } from "./snap-scenarios";

const PERIOD = "2026-09";
const EARNED = Math.ceil((15650 / 12) * 3.07);

/** Actual receipt of cash assistance or SSI confers categorical eligibility
 *  at any income (7 CFR 273.2(j)(2)); these inputs are facts, not judgments. */
const RECEIPT_ALLOWLIST: Record<string, string[]> = {
  "us-ga-snap": ["member_receives_supplemental_security_income", "member_receives_tanf", "member_receives_work_support_payments"],
  "us-ny-snap": [
    "member_authorized_to_receive_family_assistance_nonemergency_safety_net_or_ssi_benefits_but_not_yet_paid",
    "member_determined_eligible_for_family_assistance_or_nonemergency_safety_net_benefits",
    "member_family_assistance_nonemergency_safety_net_or_ssi_benefits_suspended_or_being_recouped",
    "member_receives_family_assistance_nonemergency_safety_net_or_ssi_benefits",
  ],
  "us-sc-snap": [
    "all_members_receive_or_authorized_ssi_benefits",
    "all_members_receive_or_authorized_tanf_and_or_ssi_benefits",
    "all_members_receive_or_authorized_tanf_cash",
  ],
};

/** Known encoding defects, recorded rather than hidden. Each must still
 *  reproduce: a listed defect that no longer awards fails the scan, so the
 *  list can't go stale and mask a different award later. */
const KNOWN_DEFECTS: Record<string, string[]> = {};
/** Known defects that need several inputs together: the group's inputs (as
 *  requirementGroups moves them off their defaults) and why it is listed.
 *  Same rule as KNOWN_DEFECTS: each must still award. */
const KNOWN_DEFECT_GROUPS: Record<string, Array<{ inputs: string[]; reason: string }>> = {
  "us-sc-snap": [
    {
      inputs: [
        "any_member_receives_or_authorized_family_independence_information_referral_services",
        "household_meets_non_financial_snap_eligibility_criteria",
      ],
      // SNAP Manual 4.1(D) limits this to income at or below 130% FPL; the
      // test compares household_gross_income with federal_poverty_level_for_household,
      // both 0 by default, so 0 <= 1.3 * 0 holds at any income. PR #69
      // derives both from the rules' own outputs; drop this entry with it.
      reason: "4.1(D) income and poverty-level inputs default to 0",
    },
  ],
};
/** Programs whose encoding assumes eligibility, so the baseline itself holds. */
const ASSUMED_ELIGIBLE = new Set(["us-az-snap"]);

type Row = { program: string; input: string; value: boolean; result: string; status: string };
type Group = { set: Record<string, boolean>; judgments: string[] };
type GroupRow = { program: string; inputs: Record<string, boolean>; judgments: string[]; result: string; status: string };

/** Bool inputs that one judgment needs together, from the catalog's
 *  `requires` (its `and` chain) and `requires_any` (each `or` in that chain).
 *  An `or` gives one group per alternative, and every other `or` of the same
 *  judgment takes an alternative the defaults already meet when there is
 *  one, else the first the assistant can set. So the count stays linear in
 *  the catalog (no pairs) and each group can make its judgment hold. Only
 *  bools the assistant can set count (not aux; threshold and computed
 *  entries are tests, not values), and only groups that move two or more of
 *  them off their defaults are kept: one is a single flip, scanned above. */
function requirementGroups(program: CatalogProgram, periodStart: string): Group[] {
  const slots = new Map<string, CatalogInputSlot>();
  for (const slot of Object.values(program.inputs).flat()) {
    if (!slots.get(slot.name) || slots.get(slot.name)!.aux) slots.set(slot.name, slot);
  }
  const settable = (r: Requirement) => {
    const slot = slots.get(r.slot);
    return !!slot && !slot.aux && slot.dtype === "bool" && typeof r.value === "boolean" && !r.op && !r.computed;
  };
  const atDefault = (name: string, value: boolean) => slotDefaultAt(slots.get(name)!, periodStart) === value;
  const groups = new Map<string, Group>();
  for (const output of program.outputs) {
    if (output.semantics !== "judgment" || (!output.requires && !output.requires_any)) continue;
    const ors = output.requires_any ?? [];
    const fallback = ors.map(
      (rule) =>
        rule.any_of.find((alt) => alt.every((r) => settable(r) && atDefault(r.slot, r.value as boolean))) ??
        rule.any_of.find((alt) => alt.every(settable)) ??
        rule.any_of[0]
    );
    const variants = ors.length === 0 ? [[]] : ors.flatMap((rule, i) => rule.any_of.map((alt) => ors.flatMap((_, j) => (j === i ? alt : fallback[j]))));
    for (const extra of variants) {
      const want = new Map<string, boolean>();
      let conflict = false;
      for (const r of [...(output.requires ?? []), ...extra]) {
        if (!settable(r)) continue;
        if (want.has(r.slot) && want.get(r.slot) !== r.value) conflict = true;
        want.set(r.slot, r.value as boolean);
      }
      const moved = [...want].filter(([name, value]) => !atDefault(name, value));
      if (conflict || moved.length < 2) continue;
      const key = moved.map(([name, value]) => `${name}=${value}`).sort().join("&");
      const group = groups.get(key) ?? { set: Object.fromEntries(moved), judgments: [] };
      if (!group.judgments.includes(output.name)) group.judgments.push(output.name);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

async function main() {
  if (skipWithoutEngine("test:gates")) {
    checkpoint("gates", { status: "skipped" });
    return;
  }
  const ctx = { toolCallId: "gate-scan", messages: [] } as never;
  const rows: Row[] = [];
  const groupRows: GroupRow[] = [];
  let unexpected = 0;
  let calls = 0;
  let groupCalls = 0;
  const reproducedDefects = new Set<string>();
  const reproducedGroups = new Set<string>();
  const blockedSeen = new Set<string>();
  for (const program of getCatalog().programs.filter((p) => p.program_id === "snap")) {
    const names = new Set(Object.values(program.inputs).flat().map((s) => s.name));
    const earnedSlot = names.has("snap_gross_monthly_earned_income") ? "snap_gross_monthly_earned_income" : "snap_countable_earned_income";
    const base = { household_size: 1, [earnedSlot]: EARNED };
    const member = { member_is_us_citizen: true, member_age: 35 };
    const outcome = (r: any) => {
      const eligible = r.outputs?.find((o: any) => o.name === "snap_eligible")?.value;
      const benefit = r.outputs?.find((o: any) => o.name === "snap_benefit")?.value;
      return { eligible, benefit, awarded: eligible === "holds" || (typeof benefit === "number" && benefit > 0) };
    };
    const baseline = outcome(await (tools.compute as any).execute({ program: program.slug, period: PERIOD, facts: base, members: [{ facts: member }] }, ctx));
    calls++;
    if (ASSUMED_ELIGIBLE.has(program.slug)) {
      // Its flips all inherit the eligible baseline, so check its blocked inputs directly.
      for (const input of Object.keys(ASSISTANT_UNSETTABLE_INPUTS[program.slug] ?? {})) {
        for (const value of [true, false]) {
          const r = await (tools.compute as any).execute({ program: program.slug, period: PERIOD, facts: { ...base, [input]: value }, members: [{ facts: member }] }, ctx);
          calls++;
          if (r.kind === "not_settable_input") blockedSeen.add(`${program.slug}:${input}`);
          else { unexpected++; console.log(`FAIL ${program.slug} ${input}=${value}: not blocked`); }
        }
      }
      rows.push({ program: program.slug, input: "(baseline)", value: true, result: `${baseline.eligible} $${baseline.benefit}`, status: "known: eligibility assumed" });
      console.log(`known ${program.slug}: baseline at 307% → ${baseline.eligible}, $${baseline.benefit} (eligibility assumed by the encoding)`);
      continue;
    }
    if (baseline.awarded) {
      unexpected++;
      console.log(`FAIL ${program.slug}: baseline at 307% → ${baseline.eligible}, $${baseline.benefit}`);
    }
    for (const [entity, slots] of Object.entries(program.inputs)) {
      for (const slot of slots) {
        if (slot.aux || slot.dtype !== "bool" || slot.name === "member_is_us_citizen") continue;
        const flipped = !slot.default;
        const isMember = entity === program.member_entity;
        const args = {
          program: program.slug, period: PERIOD,
          facts: { ...base, ...(isMember ? {} : { [slot.name]: flipped }) },
          members: [{ facts: { ...member, ...(isMember ? { [slot.name]: flipped } : {}) } }],
        };
        const r = await (tools.compute as any).execute(args, ctx);
        calls++;
        if (r.error) {
          // Only the assistant's blocked inputs may error here; anything else
          // is a broken scan, not a pass.
          if (r.kind !== "not_settable_input") {
            unexpected++;
            console.log(`FAIL ${program.slug} ${entity}.${slot.name}: unexpected ${r.kind ?? "error"}: ${String(r.error).slice(0, 120)}`);
          } else {
            blockedSeen.add(`${program.slug}:${slot.name}`);
          }
          continue;
        }
        const o = outcome(r);
        if (!o.awarded) continue;
        const status = RECEIPT_ALLOWLIST[program.slug]?.includes(slot.name)
          ? "allowed: benefit receipt"
          : KNOWN_DEFECTS[program.slug]?.includes(slot.name)
            ? "known defect"
            : "UNEXPECTED";
        if (status === "UNEXPECTED") unexpected++;
        if (status === "known defect") reproducedDefects.add(`${program.slug}:${slot.name}`);
        rows.push({ program: program.slug, input: `${entity}.${slot.name}`, value: flipped, result: `${o.eligible} $${o.benefit}`, status });
        console.log(`${status === "UNEXPECTED" ? "FAIL" : "ok  "} ${program.slug} ${entity}.${slot.name}=${flipped} → ${o.eligible}, $${o.benefit} (${status})`);
      }
    }
    // Each group goes in one compute, every input on the entity that reads
    // it (a slot read on the member and the household takes both).
    const groups = requirementGroups(program, `${PERIOD}-01`);
    let groupAwards = 0;
    for (const group of groups) {
      const facts: Record<string, boolean | number> = { ...base };
      const memberFacts: Record<string, boolean | number> = { ...member };
      for (const [name, value] of Object.entries(group.set)) {
        const entities = Object.keys(program.inputs).filter((entity) => program.inputs[entity].some((s) => s.name === name));
        if (entities.includes(program.member_entity ?? "")) memberFacts[name] = value;
        if (entities.some((entity) => entity !== program.member_entity)) facts[name] = value;
      }
      const inputs = Object.keys(group.set).sort();
      const label = inputs.map((name) => `${name}=${group.set[name]}`).join(" + ");
      const blocked = inputs.filter((name) => ASSISTANT_UNSETTABLE_INPUTS[program.slug]?.[name]);
      const r = await (tools.compute as any).execute({ program: program.slug, period: PERIOD, facts, members: [{ facts: memberFacts }] }, ctx);
      calls++;
      groupCalls++;
      if (r.error) {
        if (r.kind === "not_settable_input" && blocked.length > 0) {
          for (const name of blocked) blockedSeen.add(`${program.slug}:${name}`);
        } else {
          unexpected++;
          console.log(`FAIL ${program.slug} group ${label}: unexpected ${r.kind ?? "error"}: ${String(r.error).slice(0, 120)}`);
        }
        continue;
      }
      if (blocked.length > 0) {
        unexpected++;
        console.log(`FAIL ${program.slug} group ${label}: ${blocked.join(", ")} not blocked`);
        continue;
      }
      const o = outcome(r);
      if (!o.awarded) continue;
      groupAwards++;
      const listed = KNOWN_DEFECT_GROUPS[program.slug]?.find((d) => [...d.inputs].sort().join("&") === inputs.join("&"));
      // A group with an input that awards alone adds nothing the single
      // flip didn't already judge.
      const status = inputs.some((name) => RECEIPT_ALLOWLIST[program.slug]?.includes(name))
        ? "allowed: benefit receipt"
        : listed
          ? `known defect: ${listed.reason}`
          : inputs.some((name) => KNOWN_DEFECTS[program.slug]?.includes(name))
            ? "known defect"
            : "UNEXPECTED";
      if (status === "UNEXPECTED") unexpected++;
      if (listed) reproducedGroups.add(`${program.slug}:${inputs.join("&")}`);
      groupRows.push({ program: program.slug, inputs: group.set, judgments: group.judgments, result: `${o.eligible} $${o.benefit}`, status });
      console.log(`${status === "UNEXPECTED" ? "FAIL" : "ok  "} ${program.slug} group ${label} (${group.judgments.join(", ")}) → ${o.eligible}, $${o.benefit} (${status})`);
    }
    console.log(`     ${program.slug}: ${groups.length} requirement groups, ${groupAwards} award`);
  }
  for (const [slug, inputs] of Object.entries(KNOWN_DEFECTS)) {
    for (const input of inputs) {
      if (!reproducedDefects.has(`${slug}:${input}`)) {
        unexpected++;
        console.log(`FAIL ${slug} ${input}: listed as a known defect but no longer awards; remove it from KNOWN_DEFECTS`);
      }
    }
  }
  for (const [slug, groups] of Object.entries(KNOWN_DEFECT_GROUPS)) {
    for (const group of groups) {
      const key = [...group.inputs].sort().join("&");
      if (!reproducedGroups.has(`${slug}:${key}`)) {
        unexpected++;
        console.log(`FAIL ${slug} group ${group.inputs.join(" + ")}: listed as a known defect but no longer awards; remove it from KNOWN_DEFECT_GROUPS`);
      }
    }
  }
  // Every listed input that is a bool the scan flips must have been seen
  // blocked. This takes its expectations from ASSISTANT_UNSETTABLE_INPUTS, so
  // it can't notice an entry being removed; bbce-inputs.test.ts pins the list.
  for (const [slug, inputs] of Object.entries(ASSISTANT_UNSETTABLE_INPUTS)) {
    const program = getCatalog().programs.find((p) => p.slug === slug);
    for (const input of Object.keys(inputs)) {
      const slot = program && Object.values(program.inputs).flat().find((s) => s.name === input);
      if (slot && !slot.aux && slot.dtype === "bool" && !blockedSeen.has(`${slug}:${input}`)) {
        unexpected++;
        console.log(`FAIL ${slug} ${input}: in ASSISTANT_UNSETTABLE_INPUTS but the tool path did not block it`);
      }
    }
  }
  checkpoint("gates", { period: PERIOD, earned: EARNED, calls, group_calls: groupCalls, rows, group_rows: groupRows, unexpected, blocked: [...blockedSeen].sort() });
  console.log(
    `\ngate scan: ${calls} engine calls (${calls - groupCalls} baseline and single flips, ${groupCalls} requirement groups); ` +
      `${unexpected} unexpected award(s). Checkpoint: ${CHECKPOINT_DIR}/gates.json`
  );
  process.exitCode = unexpected ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
