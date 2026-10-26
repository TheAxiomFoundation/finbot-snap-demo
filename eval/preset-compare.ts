/**
 * Preset comparison: send the same short question to /api/raw (the model
 * alone) and /api/chat (the model + Axiom tools), several times each, and
 * score both sides' headline number against an independent truth value.
 *
 * Nothing here changes either prompt — this measures the app exactly as the
 * side-by-side compare mode ships it. Truth values come from the
 * PolicyEngine-agreed oracle (scripts/oracle-cases.json) or from the cited
 * official source, at the period the app actually evaluates today.
 *
 *   FINBOT_EVAL_URL=http://localhost:3947/gallery/chatbot bun x tsx eval/preset-compare.ts [runs] [id,id,...]
 *
 * Writes eval/runs/<timestamp>-presets/{summary.json,REPORT.md}.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Same extraction as src/lib/grounding.ts — kept local so this harness
 *  doesn't depend on the runtime verifier. */
function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([\d,]+)(?:\.\d+)?/g)].map((m) => Number(m[1].replace(/,/g, "")));
}

const ROOT = path.resolve(path.join(import.meta.dirname ?? __dirname, ".."));
const BASE = process.env.FINBOT_EVAL_URL ?? "http://localhost:3947/gallery/chatbot";
const RUNS = Number(process.argv[2] ?? 3);
const ONLY = process.argv[3]?.split(",");
const CONCURRENCY = Number(process.env.PRESET_CONCURRENCY ?? 4);

interface Scenario {
  id: string;
  area: string;
  question: string;
  /** Accepted truth values (e.g. a monthly and the equivalent annual figure). */
  truth: number[];
  truth_note: string;
  tolerance?: number;
}

export const SCENARIOS: Scenario[] = [
  // ── Federal tax, tax year 2026 ──────────────────────────────────────────
  {
    id: "ctc-95k",
    area: "tax",
    question: "We're married filing jointly making $95,000 with two kids, ages 8 and 5. How much child tax credit do we get in 2026?",
    truth: [4400],
    truth_note: "oracle fiit-mfj-2kids (PE ctc_value 4,400); current preset",
  },
  {
    id: "ctc-95k-short",
    area: "tax",
    question: "Married, $95,000 income, two kids. What's our 2026 child tax credit?",
    truth: [4400],
    truth_note: "oracle fiit-mfj-2kids (PE ctc_value 4,400) — shorter wording of the current preset",
  },
  {
    id: "ctc-420k",
    area: "tax",
    question: "Married couple, $420,000 income, two kids. How much child tax credit do we get for 2026?",
    truth: [3400],
    truth_note: "oracle fiit-ctc-phaseout-420k (PE ctc_value 3,400)",
  },
  {
    id: "eitc-childless-10k",
    area: "tax",
    question: "I'm 25, single, no kids, and earned $10,000 in 2026. How much EITC do I get?",
    truth: [664],
    truth_note: "oracle fiit-eitc-childless-10k (PE eitc 664)",
  },
  {
    id: "eitc-hoh-40k",
    area: "tax",
    question: "Head of household, two kids, $40,000 in wages for 2026. What's my EITC?",
    truth: [3923],
    truth_note: "oracle fiit-eitc-hoh-40k (PE eitc 3,923.23)",
  },
  {
    id: "eitc-hoh2-40k-live",
    area: "tax",
    question: "Head of household with two kids who live with me. I earned $40,000 in 2026. What's my EITC?",
    truth: [3923],
    truth_note: "PE eitc 3,923.23 (oracle fiit-eitc-hoh-40k); 2026 two-child max $7,316 − 21.06% × ($40,000 − $23,890)",
  },
  {
    id: "eitc-mom2-40k",
    area: "tax",
    question: "Single mom, two kids, $40,000 in wages in 2026. How much EITC do I get?",
    truth: [3923],
    truth_note: "PE eitc 3,923.23",
  },
  {
    id: "eitc-1kid-30k",
    area: "tax",
    question: "Single parent, one kid, earned $30,000 in 2026. What's my EITC?",
    truth: [3451],
    truth_note: "PE eitc 3,450.62 (HoH, one child)",
  },
  {
    id: "eitc-mom2-40k-ssn",
    area: "tax",
    question: "Single mom, kids 8 and 5 with SSNs, $40,000 in wages in 2026. What's my EITC?",
    truth: [3923],
    truth_note: "PE eitc 3,923.23; IRS Rev. Proc. 2025-32 two-child 2026 parameters",
  },
  {
    id: "eitc-dad2-40k-ssn",
    area: "tax",
    question: "Single dad, kids 8 and 5 with SSNs, $40,000 in wages in 2026. What's my EITC?",
    truth: [3923],
    truth_note: "the EITC starter (single dad); PE eitc 3,923.23; IRS Rev. Proc. 2025-32 two-child 2026 parameters",
  },
  {
    id: "il-elig-70k",
    area: "property-tax",
    question: "I'm 70 and own my home in Illinois. Our household income is $70,000. Can I defer my property taxes?",
    truth: [77000],
    truth_note: "Yes: the 2026 household income limit is $77,000 (encoded $75,000 for 2025, $77,000 for 2026) — verify against 320 ILCS 30",
  },
  {
    id: "eitc-mfj3-50k",
    area: "tax",
    question: "Married, three kids ages 10, 7 and 4 with SSNs, $50,000 in wages in 2026. What's our EITC?",
    truth: [4263],
    truth_note: "IRS Rev. Proc. 2025-32: $8,231 − 21.06% × ($50,000 − $31,160) = $4,263.30",
  },
  {
    id: "tariff-soccer-china",
    area: "tariff",
    question: "What's the US tariff on a $1,000 shipment of soccer balls from China?",
    truth: [0],
    truth_note: "TBD — read the engine's answer, then verify against HTSUS 9506.62.40 and chapter 99",
  },
  {
    id: "eitc-dad1-30k-ssn",
    area: "tax",
    question: "Single dad, one kid age 6 with an SSN, $30,000 in wages in 2026. What's my EITC?",
    truth: [3451],
    truth_note: "IRS Rev. Proc. 2025-32: $4,427 − 15.98% × ($30,000 − $23,890) = $3,450.62",
  },
  {
    id: "ctc-420k-ssn",
    area: "tax",
    question: "Married couple, $420,000 income, two kids with SSNs. How much child tax credit do we get for 2026?",
    truth: [3400],
    truth_note: "oracle fiit-ctc-phaseout-420k: $4,400 − $50 × 20 = $3,400",
  },
  {
    id: "senior-ded-100k",
    area: "tax",
    question: "I'm 70 and single, with $100,000 of income in 2026. How much is my new senior deduction?",
    truth: [4500],
    truth_note: "26 USC 151(d)(5)(C) (P.L. 119-21): $6,000 − 6% × ($100,000 − $75,000) = $4,500",
  },
  {
    id: "capgains-60k",
    area: "tax",
    question: "Single, $60,000 of taxable income in 2026, of which $30,000 is long-term capital gains. How much tax do I pay on the gains?",
    truth: [1583, 1582],
    truth_note: "Rev. Proc. 2025-32 §3.03: 0% up to $49,450 → $19,450 at 0%, $10,550 at 15% = $1,582.50",
  },
  {
    id: "capgains-0pct-joint",
    area: "tax",
    question: "What's the 0% long-term capital gains limit for a married couple filing jointly in 2026?",
    truth: [98900],
    truth_note: "Rev. Proc. 2025-32 §3.03: $98,900",
  },
  {
    id: "abawd-58",
    area: "snap-work",
    question: "I'm 58, live alone in New York, no kids, not working. Does SNAP's 3-month time limit apply to me?",
    truth: [0],
    truth_note: "Yes — P.L. 119-21 §10102 raised the ABAWD upper age from 54 to 64 (7 U.S.C. 2015(o)(3)(A)); verdict question, read by hand",
  },
  {
    id: "abawd-parent-15",
    area: "snap-work",
    question: "I'm a single dad in New York with a 15-year-old, and I'm not working. Does SNAP's 3-month time limit apply to me?",
    truth: [0],
    truth_note: "Yes — P.L. 119-21 lowered the dependent-child exception from under 18 to under 14 (7 U.S.C. 2015(o)(3)(C)); verdict question, read by hand",
  },
  {
    id: "snap-refugee-fl",
    area: "snap-eligibility",
    question: "I came to Florida as a refugee six months ago and have no income. Can I get SNAP?",
    truth: [0],
    truth_note: "No — since P.L. 119-21 §10108 (eff. 2025-07-04) refugee status alone no longer confers SNAP eligibility (USDA FNS OBBB alien-eligibility Q&A); verdict question, read by hand",
  },
  {
    id: "snap-refugee-nogc",
    area: "snap-eligibility",
    question: "I have refugee status but no green card yet, and I live in Florida with no income. Can I get SNAP?",
    truth: [0],
    truth_note: "No — P.L. 119-21 §10108 limits SNAP to citizens, LPRs, Cuban/Haitian entrants and COFA citizens; refugee status alone no longer qualifies (USDA FNS OBBB Q&A). The 2026-09-17 D. Or. ruling covers LPRs who were refugees, not this case.",
  },
  {
    id: "oasdi-95k",
    area: "tax",
    question: "How much Social Security tax comes out of a $95,000 salary in 2026?",
    truth: [5890],
    truth_note: "oracle oasdi-wage-95k (6.2%) — control: a plain model should get this",
  },
  // ── State TANF tables ───────────────────────────────────────────────────
  {
    id: "md-tca-max3",
    area: "tanf",
    question: "What's the maximum TANF benefit for a family of 3 in Maryland?",
    truth: [773],
    truth_note: "MD DHS IM 26-13 (eff. 2026-01-01), as encoded; PE 1.774.5 still has the IM 25-12 value $753 — current preset",
  },
  {
    id: "al-tanf-max3",
    area: "tanf",
    question: "What's the maximum TANF benefit for a family of 3 in Alabama?",
    truth: [344, 4128],
    truth_note: "oracle al-tanf-family3 (PE al_tanf 4,128/yr = 344/mo)",
  },
  {
    id: "ut-fep-max3",
    area: "tanf",
    question: "What's the maximum TANF benefit for a family of 3 in Utah?",
    truth: [662],
    truth_note: "oracle ut-tanf-family3 (PE ut_fep_payment_standard 662)",
  },
  {
    id: "ut-fep-max3-starter",
    area: "tanf",
    question: "What's the maximum monthly TANF cash benefit in Utah this month for a single parent with two children and no income?",
    truth: [662],
    truth_note: "the TANF starter; DWS Eligibility Manual Table 1 FEP maximum for a household of 3 (plain model: $498, an older table)",
  },
  {
    id: "tx-tanf-max",
    area: "tanf",
    question: "What's the maximum TANF benefit for a single parent with two kids in Texas?",
    truth: [382],
    truth_note: "oracle tx-tanf-family3 (PE tx_tanf 382)",
  },
  {
    id: "co-tanf-max",
    area: "tanf",
    question: "What's the maximum TANF benefit for a single parent with two kids in Colorado?",
    truth: [620],
    truth_note: "oracle co-tanf-family3 (PE co_tanf 620)",
  },
  {
    id: "ga-earn-400",
    area: "tanf-calc",
    question: "Single mom with two kids in Georgia earning $400 a month. How much TANF can we get?",
    truth: [274],
    truth_note: "PE ga_tanf at 2026-10 with $400/mo earnings: $424 standard of need − ($400 − $250 work deduction) = $274, under the $280 maximum",
  },
  {
    id: "al-earn-400",
    area: "tanf-calc",
    question: "Single mom with two kids in Alabama earning $400 a month. How much TANF can we get?",
    truth: [64, 768],
    truth_note: "PE al_tanf at 2026-10 with $400/mo earnings: $64/month",
  },
  {
    id: "al-vs-ga",
    area: "tanf-compare",
    question: "Single mom with two kids: does Alabama or Georgia pay more TANF?",
    truth: [344, 4128],
    truth_note: "Alabama $344/month (state plan eff. 2024-10-01) vs Georgia $280 — Alabama pays more",
  },
  {
    id: "ga-elig-900",
    area: "tanf-eligibility",
    question: "Single mom with two kids in Georgia earning $900 a month. Do we qualify for TANF?",
    truth: [0],
    truth_note: "Not eligible: $900 gross exceeds Georgia's gross income ceiling for an assistance unit of 3 ($784 = 185% of the $424 standard of need)",
  },
  {
    id: "ut-delta-4v3",
    area: "tanf-delta",
    question: "In Utah, how much more TANF does a family of 4 get than a family of 3?",
    truth: [113],
    truth_note: "DWS Table 1 FEP maximum: $775 (4) − $662 (3) = $113",
  },
  {
    id: "co-delta-3v2",
    area: "tanf-delta",
    question: "In Colorado, how much more TANF does a single parent get with three kids instead of two?",
    truth: [134],
    truth_note: "9 CCR 2503-6 §3.606.1 F 2025-07-01 chart (frozen by SB26-181): $754 − $620 = $134",
  },
  {
    id: "tx-tanf-3",
    area: "tanf",
    question: "Single mom with two kids in Texas, no income. How much TANF can we get per month?",
    truth: [382],
    truth_note: "oracle tx-tanf-family3 (PE tx_tanf 382)",
  },
  {
    id: "co-tanf-3",
    area: "tanf",
    question: "Single mom with two kids in Colorado, no income. How much TANF can we get per month?",
    truth: [620],
    truth_note: "oracle co-tanf-family3 (PE co_tanf 620)",
  },
  {
    id: "al-tanf-3",
    area: "tanf",
    question: "Single mom with two kids in Alabama, no income. How much TANF can we get per month?",
    truth: [344, 4128],
    truth_note: "oracle al-tanf-family3 (PE al_tanf 4,128/yr = 344/mo)",
  },
  {
    id: "ga-tanf-3",
    area: "tanf",
    question: "Single mom with two kids in Georgia, no income. How much TANF can we get per month?",
    truth: [280, 3360],
    truth_note: "oracle ga-tanf-family3 (PE ga_tanf 3,360/yr = 280/mo) — control: unchanged for decades",
  },
  {
    id: "ut-fep-3",
    area: "tanf",
    question: "Single mom with two kids in Utah, no income. How much TANF (FEP) can we get per month?",
    truth: [662],
    truth_note: "oracle ut-tanf-family3 (PE ut_fep_payment_standard 662)",
  },
  // ── Other certified programs ────────────────────────────────────────────
  {
    id: "il-scretd-9k",
    area: "property-tax",
    question: "I'm 70 and own my home in Illinois. My property taxes are $9,000 this year. How much can I defer?",
    truth: [7500],
    truth_note: "oracle il-scretd-senior-capped (PE 7,500 cap)",
  },
  // ── SNAP (certified rules carry FY2026 values; FY2027 began 2026-10-01) ─
  {
    id: "co-snap-1-zero",
    area: "snap",
    question: "I live alone in Colorado with no income. How much SNAP can I get?",
    truth: [306],
    truth_note: "FY2027 1-person maximum allotment $306 (USDA COLA memo, eff. 2026-10-01); FY2026 oracle value was $298",
  },
  {
    id: "ny-snap-family3",
    area: "snap",
    question: "I'm a single parent in New York with two kids (8 and 5). I earn $2,078 a month, my rent is $1,300, and I pay heating separately from rent. What SNAP would we get?",
    truth: [610],
    tolerance: 15,
    truth_note: "FY2027 ≈ $610 (PE projection at 2026-10; official NY FY2027 SUA not checked). FY2026 oracle value was $572 — current preset",
  },
];

type Side = "raw" | "axiom";

interface RunResult {
  side: Side;
  ms: number;
  text: string;
  tools: string[];
  error?: string;
}

async function runRaw(question: string): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await r.json()) as { text?: string; error?: string };
    return { side: "raw", ms: Date.now() - t0, text: body.text ?? "", tools: [], error: r.ok ? undefined : body.error ?? `HTTP ${r.status}` };
  } catch (err) {
    return { side: "raw", ms: Date.now() - t0, text: "", tools: [], error: (err as Error).message };
  }
}

async function runAxiom(question: string): Promise<RunResult> {
  const t0 = Date.now();
  const tools: string[] = [];
  let text = "";
  try {
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) return { side: "axiom", ms: Date.now() - t0, text: "", tools, error: `HTTP ${r.status}` };
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line: string) => {
      const idx = line.indexOf(":");
      if (idx < 1) return;
      const kind = line.slice(0, idx);
      try {
        const payload = JSON.parse(line.slice(idx + 1));
        if (kind === "0") text += payload as string;
        if (kind === "9") tools.push((payload as { toolName: string }).toolName);
      } catch {
        /* partial line */
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      lines.forEach(handle);
    }
    if (buffer) handle(buffer);
  } catch (err) {
    return { side: "axiom", ms: Date.now() - t0, text, tools, error: (err as Error).message };
  }
  return { side: "axiom", ms: Date.now() - t0, text, tools };
}

type Verdict = "correct" | "range" | "wrong" | "none";

interface Headline {
  verdict: Verdict;
  headline: string;
  values: number[];
  mentions_truth: boolean;
}

/** The headline is the first bold span carrying a dollar figure, else the
 *  first sentence carrying one. Same rule for both sides. */
export function scoreHeadline(text: string, s: Scenario): Headline {
  const tol = s.tolerance ?? Math.max(1.5, 0.002 * Math.max(...s.truth));
  const near = (n: number) => s.truth.some((t) => Math.abs(n - t) <= tol);
  const clean = text.replace(/[‘’]/g, "'");
  // Dollar figures the user stated ($95,000 of income) are not answers.
  const given = new Set(dollarsIn(s.question));
  const answers = (t: string) => dollarsIn(t).filter((n) => !given.has(n));
  const bold = [...clean.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]).find((b) => answers(b).length > 0);
  const sentence = clean.split(/(?<=[.!?])\s+|\n+/).find((l) => answers(l).length > 0);
  const headline = (bold ?? sentence ?? "").trim();
  const values = answers(headline);
  const mentions_truth = dollarsIn(clean).some(near);
  if (!values.length) return { verdict: "none", headline, values, mentions_truth };
  const range = headline.match(/\$\s?([\d,]+)(?:\.\d+)?\s*(?:–|—|-|to)\s*\$?\s?([\d,]+)/);
  if (range) {
    const lo = Number(range[1].replace(/,/g, ""));
    const hi = Number(range[2].replace(/,/g, ""));
    if (lo !== hi) {
      const inside = s.truth.some((t) => t >= lo - tol && t <= hi + tol);
      return { verdict: inside ? "range" : "wrong", headline, values, mentions_truth };
    }
  }
  return { verdict: values.some(near) ? "correct" : "wrong", headline, values, mentions_truth };
}

async function pool<T>(jobs: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    })
  );
  return out;
}

async function main() {
  const scenarios = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id));
  const jobs: Array<() => Promise<{ s: Scenario; r: RunResult }>> = [];
  for (let i = 0; i < RUNS; i++) {
    for (const s of scenarios) {
      jobs.push(async () => ({ s, r: await runRaw(s.question) }));
      jobs.push(async () => ({ s, r: await runAxiom(s.question) }));
    }
  }
  let done = 0;
  const results = await pool(
    jobs.map((job) => async () => {
      const x = await job();
      done++;
      const h = scoreHeadline(x.r.text, x.s);
      console.log(`[${done}/${jobs.length}] ${x.s.id.padEnd(18)} ${x.r.side.padEnd(5)} ${(x.r.ms / 1000).toFixed(1).padStart(5)}s ${x.r.error ? "ERROR " + x.r.error : h.verdict.padEnd(7) + " " + h.headline.slice(0, 90)}`);
      return { ...x, h };
    }),
    CONCURRENCY
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(ROOT, "eval", "runs", `${stamp}-presets`);
  mkdirSync(dir, { recursive: true });

  const summary = scenarios.map((s) => {
    const mine = results.filter((x) => x.s.id === s.id);
    const side = (k: Side) => {
      const rs = mine.filter((x) => x.r.side === k);
      const count = (v: Verdict) => rs.filter((x) => !x.r.error && x.h.verdict === v).length;
      return {
        runs: rs.length,
        errors: rs.filter((x) => x.r.error).length,
        correct: count("correct"),
        range: count("range"),
        wrong: count("wrong"),
        none: count("none"),
        mentions_truth: rs.filter((x) => x.h.mentions_truth).length,
        median_s: Number((rs.map((x) => x.r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] / 1000).toFixed(1)),
        headlines: rs.map((x) => (x.r.error ? `ERROR ${x.r.error}` : x.h.headline)),
      };
    };
    return { id: s.id, area: s.area, question: s.question, words: s.question.split(/\s+/).length, truth: s.truth, truth_note: s.truth_note, raw: side("raw"), axiom: side("axiom") };
  });
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 1));
  writeFileSync(path.join(dir, "results.json"), JSON.stringify(results.map((x) => ({ id: x.s.id, ...x.r })), null, 1));

  const md: string[] = [`# Preset comparison — ${stamp}`, "", `${RUNS} runs per side · base ${BASE}`, ""];
  md.push("| id | words | truth | raw correct | axiom correct | raw headlines | axiom headlines | raw s | axiom s |", "|---|---|---|---|---|---|---|---|---|");
  for (const x of summary) {
    const fmt = (h: string[]) => h.map((t) => t.replace(/\|/g, "/").slice(0, 70)).join("<br>");
    md.push(`| ${x.id} | ${x.words} | $${x.truth[0]} | ${x.raw.correct}/${x.raw.runs}${x.raw.range ? ` (+${x.raw.range} range)` : ""} | ${x.axiom.correct}/${x.axiom.runs} | ${fmt(x.raw.headlines)} | ${fmt(x.axiom.headlines)} | ${x.raw.median_s} | ${x.axiom.median_s} |`);
  }
  md.push("", "## Transcripts", "");
  for (const s of scenarios) {
    md.push(`### ${s.id}`, "", `> ${s.question}`, "", `truth: ${s.truth.map((t) => `$${t}`).join(" / ")} — ${s.truth_note}`, "");
    for (const x of results.filter((y) => y.s.id === s.id)) {
      md.push(`#### ${x.r.side} · ${x.h.verdict} · ${(x.r.ms / 1000).toFixed(1)}s${x.r.tools.length ? ` · tools: ${x.r.tools.join(", ")}` : ""}`, "", x.r.error ? `ERROR: ${x.r.error}` : x.r.text, "");
    }
  }
  writeFileSync(path.join(dir, "REPORT.md"), md.join("\n"));
  console.log(`\nwrote ${dir}`);
}

if (process.argv[1]?.endsWith("preset-compare.ts")) void main();
