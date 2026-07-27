/**
 * Server-side program pre-fetch for /api/chat.
 *
 * Latency: the model's first round-trip in almost every conversation is a
 * describe_program call whose payload the server can compute in ~1ms. When
 * the user's message names a certified program unambiguously (state name +
 * program vocabulary, both derived from the catalog), we inject the exact
 * describe_program payload into the system prompt so the model can go
 * straight to compute — saving one full LLM round-trip per question.
 *
 * Detection is deliberately conservative: it only ever ADDS context the
 * model was going to request anyway. A miss (no injection) or a wrong guess
 * (irrelevant program injected) leaves the normal describe_program flow
 * untouched — the prompt tells the model to verify the slug before relying
 * on it — so accuracy never depends on this heuristic being right.
 */
import { getCatalog, type CatalogProgram } from "./catalog";
import { describeProgramPayload } from "./describe";

const MAX_PREFETCH = 2;

/** USPS code → names a user might write. Pure geography, not program data. */
const STATE_NAMES: Record<string, string[]> = {
  al: ["alabama"], ak: ["alaska"], az: ["arizona"], ar: ["arkansas"],
  ca: ["california"], co: ["colorado"], ct: ["connecticut"], de: ["delaware"],
  fl: ["florida"], ga: ["georgia"], hi: ["hawaii"], id: ["idaho"],
  il: ["illinois"], in: ["indiana"], ia: ["iowa"], ks: ["kansas"],
  ky: ["kentucky"], la: ["louisiana"], me: ["maine"], md: ["maryland"],
  ma: ["massachusetts"], mi: ["michigan"], mn: ["minnesota"], ms: ["mississippi"],
  mo: ["missouri"], mt: ["montana"], ne: ["nebraska"], nv: ["nevada"],
  nh: ["new hampshire"], nj: ["new jersey"], nm: ["new mexico"],
  ny: ["new york", "nyc"], nc: ["north carolina"], nd: ["north dakota"],
  oh: ["ohio"], ok: ["oklahoma"], or: ["oregon"], pa: ["pennsylvania"],
  ri: ["rhode island"], sc: ["south carolina"], sd: ["south dakota"],
  tn: ["tennessee"], tx: ["texas"], ut: ["utah"], vt: ["vermont"],
  va: ["virginia"], wa: ["washington"], wv: ["west virginia"],
  wi: ["wisconsin"], wy: ["wyoming"], dc: ["district of columbia", "washington dc"],
};

/** Program-family vocabularies — national synonym sets keyed off the
 *  display name, so every TANF-family program (TANF/TCA/ATAP/…) shares the
 *  cash-assistance vocabulary and every SNAP program the food-assistance
 *  one. Category-level config, not per-program code. */
const FAMILIES: Array<{ test: RegExp; tokens: string[] }> = [
  {
    test: /\b(tanf|tca|temporary cash assistance)\b/i,
    tokens: ["tanf", "tca", "atap", "temporary cash assistance", "cash assistance", "welfare"],
  },
  {
    test: /\bsnap\b/i,
    tokens: ["snap", "food stamps", "food stamp", "food assistance", "food benefits", "calfresh"],
  },
  {
    test: /\bincome tax\b/i,
    tokens: [
      "income tax", "child tax credit", "ctc",
      "earned income tax credit", "eitc", "tax credit", "tax refund", "tax liability",
    ],
  },
  {
    test: /\b(oasdi|wage tax)\b/i,
    tokens: ["oasdi", "wage tax", "payroll tax", "social security tax", "fica"],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsAny(text: string, tokens: string[]): boolean {
  return tokens.some((tok) => new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i").test(text));
}

/** Vocabulary for one program: its family tokens, or (for programs outside
 *  every family, e.g. the IL real-estate tax deferral) the display name with
 *  the state stripped. */
function programTokens(p: CatalogProgram): string[] {
  const family = FAMILIES.find((f) => f.test.test(p.display_name));
  if (family) return family.tokens;
  const stateCode = p.jurisdiction.startsWith("us-") ? p.jurisdiction.slice(3) : null;
  const stateNames = stateCode ? STATE_NAMES[stateCode] ?? [] : [];
  let name = p.display_name.toLowerCase();
  for (const s of stateNames) name = name.replace(s, "");
  name = name.replace(/\(.*?\)/g, "").trim();
  return name ? [name] : [];
}

/** Slugs of certified programs the text plausibly asks about. State-scoped
 *  matches (state named + program vocabulary) win over federal ones; empty
 *  when nothing (or too much) matches. */
export function detectProgramSlugs(text: string): string[] {
  const catalog = getCatalog();
  const candidates = catalog.programs.filter((p) => mentionsAny(text, programTokens(p)));
  const stateHits = candidates.filter((p) => {
    const code = p.jurisdiction.startsWith("us-") ? p.jurisdiction.slice(3) : null;
    return code !== null && mentionsAny(text, STATE_NAMES[code] ?? []);
  });
  const picked = stateHits.length > 0 ? stateHits : candidates.filter((p) => p.jurisdiction === "us");
  return picked.slice(0, MAX_PREFETCH).map((p) => p.slug);
}

/** The system-prompt section for the detected programs, or null. `text`
 *  should be the concatenated user messages of the conversation so the
 *  injection stays stable across follow-up turns. */
export function prefetchSection(text: string): string | null {
  const slugs = detectProgramSlugs(text);
  if (slugs.length === 0) return null;
  const catalog = getCatalog();
  const blocks = slugs.map((slug) => {
    const program = catalog.programs.find((p) => p.slug === slug)!;
    return `### ${slug}\n${JSON.stringify(describeProgramPayload(program))}`;
  });
  return `PRE-FETCHED PROGRAM SURFACE — the server already ran describe_program for the program(s) this conversation most likely concerns (heuristic keyword detection). Each block below is a complete, authoritative describe_program response. If the program YOU chose from the coverage digest appears here, do NOT call describe_program for it — treat its block as the describe response and go straight to compute. If your program is not below (the heuristic can be wrong — always verify the slug), call describe_program as usual.\n\n${blocks.join("\n\n")}`;
}
