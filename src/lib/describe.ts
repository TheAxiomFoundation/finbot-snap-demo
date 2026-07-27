/**
 * Shared builder for the describe_program payload. Used by the
 * describe_program tool and by the server-side pre-fetch in /api/chat —
 * the pre-fetch injects this exact payload into the system prompt so the
 * model gets the slot surface without spending an LLM round-trip on it.
 */
import type { CatalogProgram } from "./catalog";
import { defaultPeriodFor } from "./request-builder";

/** Compact one-token slot description:
 *  `name:dtype`, `=default` when non-zero/false, `{1=joint,2=separate}` for
 *  enum codes (labels reduced to their distinctive tails), `(eq 12)` for
 *  equality-gate values, trailing `*` for branch-selector flags. */
function describeSlot(s: CatalogProgram["inputs"][string][number]): string {
  let out = `${s.name}:${s.dtype}`;
  if (s.enum) {
    const labels = Object.values(s.enum);
    const prefix = commonPrefix(labels.filter(Boolean));
    const entries = Object.entries(s.enum)
      .map(([value, label]) => `${value}${label ? `=${label.slice(prefix.length) || label}` : ""}`)
      .join(",");
    out += `{${entries}}`;
  }
  if (!(s.default === false || s.default === 0 || s.default === "")) out += `=${s.default}`;
  if (s.eq_hints?.length) out += `(eq ${s.eq_hints.join("|")})`;
  if (s.variant_switch) out += "*";
  if (s.aux) out = "~" + out;
  return out;
}

function commonPrefix(strings: string[]): string {
  if (strings.length < 2) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export function describeProgramPayload(program: CatalogProgram, inputsSearch?: string) {
  const INPUT_CAP = 120;
  const filter = inputsSearch?.toLowerCase();
  const inputs: Record<string, { slots: string[]; omitted: number; aux_hidden?: number }> = {};
  const defaultOverrides: Record<string, boolean | number | string> = {};
  for (const [entity, slots] of Object.entries(program.inputs)) {
    const matching = slots.filter((s) => !filter || s.name.toLowerCase().includes(filter));
    // Without a search filter, show only slots on the certified-output
    // path — the auxiliary majority can't move the headline and would
    // drown the ones that do (and bloat every later model step).
    const relevant = filter ? matching : matching.filter((s) => !s.aux);
    const shown = relevant.slice(0, INPUT_CAP);
    inputs[entity] = {
      slots: shown.map(describeSlot),
      omitted: relevant.length - shown.length,
      ...(filter ? {} : { aux_hidden: matching.length - relevant.length }),
    };
    for (const s of slots) {
      if (s.default_source === "overlay") defaultOverrides[s.name] = s.default;
    }
  }
  const shortName = (name: string) => name.split("#").pop()!.replace(/^relation\./, "");
  return {
    slug: program.slug,
    display_name: program.display_name,
    description: program.description,
    default_period: defaultPeriodFor(program),
    primary_entity: program.primary_entity,
    member_entity: program.member_entity,
    relations: program.relations
      .filter((r) => r.used)
      .map((r) => ({ name: shortName(r.name), related_entity: r.related_entity })),
    primary_output: program.primary_output,
    certified_outputs: program.certified_outputs,
    acknowledged_incomplete: program.acknowledged_incomplete,
    total_outputs: program.outputs.length,
    inputs,
    ...(Object.keys(defaultOverrides).length > 0 && {
      default_overrides: defaultOverrides,
      default_overrides_note:
        "Curated defaults for law-variant/administrative inputs (already applied; override only if the user's situation differs).",
    }),
    slot_legend:
      "{1=a,2=b} enum codes (use ONLY listed codes; unlisted values fall through to the default branch) · (eq N) a value some rules require exactly — set it when ordinarily true and disclose · trailing * = branch selector that flips which rules apply, set deliberately · leading ~ = auxiliary slot NOT on the certified-output path: setting it cannot change the headline, prefer the non-~ sibling",
    notes: [
      "Facts you don't provide default to false/0 — state the defaults you rely on.",
      "aux_hidden counts auxiliary slots not on the certified-output path (they can't change the headline); pass inputs_search to see them.",
      program.member_entity
        ? `Members: pass members[] (facts use ${program.member_entity}-scope slots), or a *_size fact to synthesize identical members.`
        : "This program has no member entity; only top-level facts apply.",
      "Any of the total_outputs encoded outputs can be read with lookup_value or compute extra_outputs.",
    ],
  };
}
