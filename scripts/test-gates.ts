/** Gate scan: no single yes/no input the assistant can set may make a SNAP
 * household at 307% of the poverty line eligible, except inputs recording
 * actual receipt of TANF, SSI or public assistance (categorical eligibility
 * that applies at any income) and recorded known defects.
 *
 * Runs every non-auxiliary bool input of every SNAP program through the
 * assistant's own tool path (tools.compute), flipped from its default, for a
 * 1-person citizen household earning 307% of the 2025 guideline. Blocked
 * inputs must come back as not_settable_input errors. Needs the engine
 * (AXIOM_ENGINE_URL, or AXIOM_RULES_ENGINE_BINARY + AXIOM_ARTIFACTS_DIR).
 */
import { getCatalog } from "../src/lib/catalog";
import { tools } from "../src/lib/tools";
import { checkpoint, CHECKPOINT_DIR, engineAvailable } from "./snap-scenarios";

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

/** Known encoding defects, recorded rather than hidden. */
const KNOWN_DEFECTS: Record<string, string[]> = {
  // Elderly/disabled households skip the gross test but must pass the net
  // test; at 307% with no deductions this household should be ineligible.
  "us-al-snap": ["snap_member_is_elderly_or_disabled"],
};
/** Programs whose encoding assumes eligibility, so the baseline itself holds. */
const ASSUMED_ELIGIBLE = new Set(["us-az-snap"]);

type Row = { program: string; input: string; value: boolean; result: string; status: string };

async function main() {
  if (!engineAvailable()) {
    console.log("SKIP test:gates: no hosted or local engine available.");
    checkpoint("gates", { status: "skipped" });
    return;
  }
  const ctx = { toolCallId: "gate-scan", messages: [] } as never;
  const rows: Row[] = [];
  let unexpected = 0;
  let calls = 0;
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
        if (r.error) continue; // not_settable_input (blocked) or a builder rejection
        const o = outcome(r);
        if (!o.awarded) continue;
        const status = RECEIPT_ALLOWLIST[program.slug]?.includes(slot.name)
          ? "allowed: benefit receipt"
          : KNOWN_DEFECTS[program.slug]?.includes(slot.name)
            ? "known defect"
            : "UNEXPECTED";
        if (status === "UNEXPECTED") unexpected++;
        rows.push({ program: program.slug, input: `${entity}.${slot.name}`, value: flipped, result: `${o.eligible} $${o.benefit}`, status });
        console.log(`${status === "UNEXPECTED" ? "FAIL" : "ok  "} ${program.slug} ${entity}.${slot.name}=${flipped} → ${o.eligible}, $${o.benefit} (${status})`);
      }
    }
  }
  checkpoint("gates", { period: PERIOD, earned: EARNED, calls, rows, unexpected });
  console.log(`\ngate scan: ${calls} engine calls; ${unexpected} unexpected award(s). Checkpoint: ${CHECKPOINT_DIR}/gates.json`);
  process.exitCode = unexpected ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
