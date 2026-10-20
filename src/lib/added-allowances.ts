/**
 * Allowances the rules add on top of a cost slot (the catalog's
 * `added_allowances`).
 *
 * SNAP's standard utility allowance is used "in place of actual costs"
 * (7 CFR 273.9(d)(6)(iii)(A)). Where a program sums it with
 * household_shelter_costs_incurred (us-az-snap shelter_costs =
 * household_shelter_costs_incurred + az_applied_utility_allowance), that slot
 * takes rent or mortgage, property tax and insurance only. A utility bill or
 * a stated utility allowance put into it counts the utilities twice: "rent
 * $900, utility allowance $323" sent as 1,223 got the $323 again and the
 * excess shelter deduction zeroed net income ($298 instead of $219).
 * 7 CFR 273.9(d)(6)(ii)(C) counts utilities as shelter costs, so the slot
 * name alone doesn't say they are left out.
 */
import { slotDefaultAt, type CatalogInputSlot, type CatalogProgram } from "./catalog";

export type AllowanceSlot = CatalogInputSlot & {
  added_allowances: NonNullable<CatalogInputSlot["added_allowances"]>;
};

/** On-path slots the rules add a computed allowance to. */
export function allowanceSlots(program: CatalogProgram): AllowanceSlot[] {
  return Object.values(program.inputs).flatMap((slots) =>
    slots.filter((s): s is AllowanceSlot => !s.aux && (s.added_allowances?.length ?? 0) > 0)
  );
}

/** The allowances' flags that are true by default and not set in `facts`:
 *  the facts the app supplied on the user's behalf (us-az-snap defaults
 *  four utility facts to true, so the standard allowance applies unasked). */
export function defaultedAllowanceFlags(
  program: CatalogProgram,
  slot: AllowanceSlot,
  periodStart: string,
  facts: Record<string, unknown> = {}
): string[] {
  const byName = new Map(Object.values(program.inputs).flat().map((s) => [s.name, s]));
  const flags = new Set(slot.added_allowances.flatMap((a) => a.flags));
  return [...flags]
    .filter((name) => !(name in facts) && byName.has(name) && slotDefaultAt(byName.get(name)!, periodStart) === true)
    .sort();
}

const isUtility = (slot: AllowanceSlot) => slot.added_allowances.some((a) => /utility/.test(a.rule));

/** describe_program note for one allowance slot. */
export function allowanceDescribeNote(program: CatalogProgram, slot: AllowanceSlot, periodStart: string): string {
  const rules = slot.added_allowances.map((a) => a.rule);
  const defaults = defaultedAllowanceFlags(program, slot, periodStart);
  const flags = [...new Set(slot.added_allowances.flatMap((a) => a.flags))].sort();
  const utility = isUtility(slot);
  const covers = utility
    ? "a standard utility allowance stands in for actual utility costs (7 CFR 273.9(d)(6)(iii))"
    : "an allowance stands in for the actual costs it covers";
  const what = utility
    ? `only rent or mortgage, property tax and insurance — never a utility bill or a utility allowance the user states`
    : `only the costs the allowance does not cover`;
  const applies = defaults.length
    ? `true by default: ${defaults.join(", ")}`
    : `all false by default — set the one the user's situation supports (${flags.slice(0, 3).join(", ")}${flags.length > 3 ? ", …" : ""})`;
  return `${slot.name} (+${rules.join("+")}): the rules add ${rules.length > 1 ? "these allowances" : "this allowance"} to the slot — ${covers}. In ${slot.name} put ${what}. The allowance's own flags decide whether it applies; ${applies}.`;
}

/** Applied-report warning when the caller set an allowance slot and the
 *  rules added a nonzero allowance on top of it (the amounts also sit in
 *  `applied.added_allowances` as numbers). The builder can't tell whether
 *  the stated figure already included the expense, so the model checks it
 *  against what the user said. */
export function allowanceWarning(
  slot: AllowanceSlot,
  stated: unknown,
  added: Array<{ rule: string; amount: number }>,
  defaults: string[]
): string {
  const utility = isUtility(slot);
  const sum = added.map((a) => `${a.rule}=${a.amount}`).join(" + ");
  const why = utility ? " (a standard utility allowance stands in for actual utility costs, 7 CFR 273.9(d)(6)(iii))" : "";
  const reads = defaults.length ? `; it reads these defaults: ${defaults.map((f) => `${f}=true`).join(", ")}` : "";
  const included = utility ? "a utility bill or a utility allowance" : "the costs that allowance stands in for";
  const net = utility ? "rent or mortgage, property tax and insurance only" : "net of those costs";
  return (
    `WARNING: the rules added ${sum} on top of ${slot.name}=${stated}${why}${reads}. ` +
    `If the ${stated} you set already includes ${included}, it counts twice: recompute once with ${slot.name} = ${net} — the rules keep adding the allowance. ` +
    `If ${stated} is only those costs, keep this result. Either way, state the added allowance in Assumptions.`
  );
}
