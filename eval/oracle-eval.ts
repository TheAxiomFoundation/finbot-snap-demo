/**
 * Prompt-review harness. See eval/README.md.
 *
 * Runs natural-language cases through the full chat stack — oracle-anchored
 * calculations, honesty traps, lookups, and multi-turn flows — captures the
 * complete transcript with timings, applies the review rubric, and archives
 * everything under eval/runs/<timestamp>-<model>/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.join(import.meta.dirname ?? __dirname, ".."));
const BASE = process.env.FINBOT_EVAL_URL ?? "http://localhost:3947";
const DEFAULT_BUDGET_MS = 45_000;
const DEFAULT_BUDGET_STEPS = 6;

interface EvalCase {
  id: string;
  /** One or more user turns; assistant replies feed forward as history. */
  turns: string[];
  /** Join to scripts/oracle-cases.json for engine/PolicyEngine-agreed values. */
  oracle_id?: string;
  expect?: Array<{ pe_variable: string; label: string }>;
  /** Static expected dollar amounts (any must appear). */
  expect_amounts?: number[];
  /** Case-insensitive regex sources that must match the combined reply text. */
  expect_match?: string[];
  expect_not_match?: string[];
  /** Skip the every-dollar-grounded check (rarely). */
  skip_grounding?: boolean;
  budget_ms?: number;
  budget_steps?: number;
}

const CASES: EvalCase[] = [
  // ── Oracle-anchored single-turn calculations ─────────────────────────────
  {
    id: "ny-snap-family3",
    turns: ["I'm a single parent in New York with two kids (8 and 5). I earn $2,078 a month, my rent is $1,300, and I pay heating separately from rent. What SNAP would we get?"],
    oracle_id: "ny-snap-family3",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  {
    id: "co-snap-single-max",
    turns: ["I live alone in Colorado and currently have no income at all. How much SNAP can I get?"],
    oracle_id: "co-snap-single-max",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  {
    id: "ca-snap-family4",
    turns: ["We're a married couple in California with kids aged 6 and 4. I earn $2,500/month, our rent is $1,800, and we pay heating and cooling separately from rent. What would our CalFresh benefit be?"],
    oracle_id: "ca-snap-family4",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  {
    id: "az-snap-elderly",
    turns: ["I'm 67, live alone in Arizona on $1,200 a month of Social Security. My rent is $900 and my utility allowance is $323. Am I eligible for SNAP and how much?"],
    oracle_id: "az-snap-elderly",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  {
    id: "fl-snap-family3",
    turns: ["Single parent in Florida, kids 8 and 5, I make $1,800 a month and pay $1,100 rent (no separate utility bills). How much SNAP?"],
    oracle_id: "fl-snap-family3",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  {
    id: "co-tanf-family3",
    turns: ["I'm a single mom with two kids in Colorado and no income right now. How much Colorado Works cash assistance could I get per month?"],
    oracle_id: "co-tanf-family3",
    expect: [{ pe_variable: "co_tanf", label: "monthly TANF" }],
  },
  {
    id: "ks-tanf-family3",
    turns: ["We're a family of three in Kansas with no income, in shelter group I. What's our monthly TANF cash benefit?"],
    oracle_id: "ks-tanf-family3",
    expect: [{ pe_variable: "ks_tanf", label: "monthly TANF" }],
  },
  {
    id: "tx-tanf-family3",
    turns: ["Single mother, two kids, in Texas, no income at all. How much TANF cash help could I get monthly?"],
    oracle_id: "tx-tanf-family3",
    expect: [{ pe_variable: "tx_tanf", label: "monthly TANF" }],
  },
  {
    id: "ma-snap-parent-1kid",
    turns: ["I live in Massachusetts with my 4-year-old, earn $1,500 a month, pay $1,400 rent plus heat separately. We're both US citizens. What SNAP would we get?"],
    oracle_id: "ma-snap-parent-1kid",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  {
    id: "fiit-eitc-hoh-2kids",
    turns: ["I file as head of household with two kids, 8 and 5, who live with me all year and have SSNs. I earned $18,000 in wages in 2026. How much EITC do I get?"],
    oracle_id: "fiit-eitc-hoh-2kids",
    expect: [{ pe_variable: "eitc", label: "EITC" }],
  },
  {
    id: "fiit-ctc-phaseout",
    turns: ["We're married filing jointly with $420,000 of income and two young kids with SSNs. Do we still get any child tax credit in 2026?"],
    oracle_id: "fiit-ctc-phaseout-420k",
    expect: [{ pe_variable: "ctc_value", label: "child tax credit" }],
    budget_ms: 90_000,
  },
  // ── Multi-turn flow ──────────────────────────────────────────────────────
  {
    // Wages-only FIIT question: 26 USC 63 is not encoded (rulespec-us#953),
    // so taxable income is underivable. This pins the acceptable band: the
    // reply must ask for taxable income and must NOT present the spurious
    // $0 tax (computed off the taxable_income default) or a $1,000 CTC (the
    // SSN-gate demotion to 2 × $500 other-dependent credits). The ideal reply
    // also states the $4,400 CTC — model behavior varies between computing it
    // and deferring it; both are honest, so the amount is not required.
    // Once #953 lands and the release is bumped, tighten this back to
    // expect_amounts [7040, 4400] with no ask.
    id: "fiit-wages-only-honesty",
    turns: ["We're a married couple filing jointly with two young kids and $95,000 in wages. What's our 2026 federal income tax and child tax credit?"],
    expect_match: ["taxable income"],
    expect_not_match: [
      "(income tax|federal tax)[^.]{0,40}\\$0|\\$0[^.]{0,30}(income tax|federal tax)",
      "child tax credit[^.]{0,60}\\$1,000|\\$1,000[^.]{0,60}child tax credit",
    ],
    // describe + full-facts compute + demotion repair legitimately runs long
    budget_ms: 60_000,
  },
  {
    id: "fiit-ctc-why-flow",
    turns: [
      "Married filing jointly, two kids (8 and 5) with valid SSNs who live with us all year. Taxable income $62,800 on $95,000 of wages. What's our 2026 federal income tax before credits, and our child tax credit?",
      "Why is our child tax credit that amount exactly?",
    ],
    oracle_id: "fiit-mfj-2kids",
    expect: [
      { pe_variable: "income_tax_main_rates", label: "tax before credits" },
      { pe_variable: "ctc_value", label: "child tax credit" },
    ],
    // Turn-2 explanation must reference child qualification and the phaseout
    // (the two levers) — exact per-child figures are optional phrasing.
    expect_match: ["qualif", "phase.?out|phaseout|no phaseout"],
    budget_ms: 90_000,
    budget_steps: 12,
  },
  // ── Lookup ───────────────────────────────────────────────────────────────
  {
    id: "lookup-max-allotment-hh6",
    turns: ["What's the maximum monthly SNAP allotment for a household of 6 in Colorado?"],
    expect_amounts: [1421],
  },
  // ── Honesty traps ────────────────────────────────────────────────────────
  {
    id: "tx-snap-honesty",
    turns: ["How much SNAP can I get in Texas? Family of 3, no income."],
    // TX SNAP is not certified (only TX TANF). Must not invent a SNAP figure;
    // naming covered alternatives is the expected shape.
    expect_match: ["(hasn'?t|has not|isn'?t|is not|not)[^.]{0,80}(certif|encod|cover|availab)"],
    expect_not_match: ["\\$\\d+\\s*(/|per\\s)?month[^.]{0,40}(SNAP|snap)"],
  },
  {
    id: "wic-honesty",
    turns: ["How much WIC would I get for my newborn in Colorado?"],
    expect_match: ["(hasn'?t|has not|isn'?t|is not|not)[^.]{0,80}(certif|encod|cover|availab)"],
  },
  {
    id: "ny-income-tax-trap",
    turns: ["How much New York state income tax would I owe on $80,000 of income in 2026?"],
    // us-ny-income-tax takes the NY brackets and standard deduction as
    // INPUTS (parameter-as-input pilot; rulespec-us#949) and its liability
    // output is acknowledged_incomplete. A $0-or-invented liability presented
    // as the answer is a failure; flagging the gap is the expected behavior.
    expect_match: ["incomplete|not fully encoded|cannot|can't|unable|not.{0,40}(reliable|settled)"],
    expect_not_match: ["\\*\\*[^*]*owe[^*]*\\$\\s?[1-9][\\d,]*[^*]*\\*\\*"],
    budget_ms: 45_000,
  },
];

// ---------------------------------------------------------------------------

interface OracleDoc {
  pe_version: string;
  cases: Array<{ id: string; program: string; tolerance: number; pe_values: Record<string, number> }>;
}

interface StreamEvent {
  t: number;
  kind: string;
  payload: unknown;
}

type Message = { role: "user" | "assistant"; content: string };

async function runTurn(messages: Message[]): Promise<{
  events: StreamEvent[];
  text: string;
  model: string | null;
  error?: string;
}> {
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return { events: [], text: "", model: null, error: `fetch failed: ${(err as Error).message}` };
  }
  if (!r.ok) return { events: [], text: "", model: null, error: `HTTP ${r.status}` };
  const model = r.headers.get("x-finbot-model");

  const events: StreamEvent[] = [];
  let text = "";
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
      if (["9", "a", "e", "3"].includes(kind)) {
        events.push({ t: Date.now() - t0, kind, payload });
      }
    } catch {
      /* partial line */
    }
  };
  try {
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
    return { events, text, model, error: `stream aborted: ${(err as Error).message}` };
  }
  return { events, text, model };
}

function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([\d,]+)(?:\.\d+)?/g)].map((m) => Number(m[1].replace(/,/g, "")));
}

/** Extend grounded numbers with simple shown-arithmetic combinations the
 *  reply may legitimately derive from them: pairwise sums/differences, the
 *  SNAP 30%-of-net figure, and per-unit divisions by small member counts
 *  ("$4,400 across 2 qualifying children" → $2,200). */
function withDerivedCombinations(grounded: Set<number>): Set<number> {
  const out = new Set(grounded);
  const values = [...grounded].filter((n) => n >= 1 && n <= 1_000_000);
  const cap = 250; // avoid quadratic blowup on huge result sets
  const sample = values.slice(0, cap);
  for (const a of sample) {
    out.add(Math.round(a * 0.3));
    out.add(Math.ceil(a * 0.3));
    out.add(Math.floor(a * 0.3));
    for (const count of [2, 3, 4, 5, 6]) out.add(Math.round(a / count));
    for (const b of sample) {
      out.add(Math.abs(Math.round(a - b)));
      out.add(Math.round(a + b));
    }
  }
  return out;
}

function numbersInResults(results: unknown[]): Set<number> {
  const out = new Set<number>();
  const visit = (v: unknown) => {
    if (typeof v === "number") { out.add(Math.round(v)); out.add(Math.floor(v)); out.add(Math.ceil(v)); }
    else if (typeof v === "string" && /^-?[\d.]+$/.test(v)) out.add(Math.round(Number(v)));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  results.forEach(visit);
  return out;
}

function derivableFromPrompt(prompt: string): Set<number> {
  const numbers = [...prompt.matchAll(/\$?\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  const allowed = new Set<number>(numbers.map(Math.round));
  for (const a of numbers) {
    for (const b of numbers) for (const p of [a * b, a * b * 4.33]) { allowed.add(Math.round(p)); allowed.add(Math.floor(p)); allowed.add(Math.ceil(p)); }
    for (const c of [a * 4.33, a * 12, a / 12]) { allowed.add(Math.round(c)); allowed.add(Math.floor(c)); allowed.add(Math.ceil(c)); }
  }
  return allowed;
}

interface CaseReport {
  id: string;
  wall_ms: number;
  steps: number;
  tool_sequence: string[];
  checks: Record<string, { pass: boolean; note: string }>;
  pass: boolean;
}

async function evaluateCase(
  c: EvalCase,
  oracle: OracleDoc["cases"][number] | undefined,
  runDir: string
): Promise<CaseReport> {
  const started = Date.now();
  const messages: Message[] = [];
  const turns: Array<Awaited<ReturnType<typeof runTurn>>> = [];
  for (const turn of c.turns) {
    messages.push({ role: "user", content: turn });
    const result = await runTurn(messages);
    turns.push(result);
    if (result.error) break;
    messages.push({ role: "assistant", content: result.text });
  }
  const wall = Date.now() - started;

  const allEvents = turns.flatMap((t) => t.events);
  const toolCalls = allEvents.filter((e) => e.kind === "9").map((e) => e.payload as { toolName: string; args: unknown });
  const toolResults = allEvents.filter((e) => e.kind === "a").map((e) => (e.payload as { result: unknown }).result);
  const steps = allEvents.filter((e) => e.kind === "e").length;
  // Normalize typographic quotes so honesty regexes match curly apostrophes.
  const allText = turns.map((t) => t.text).join("\n\n").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const error = turns.find((t) => t.error)?.error;

  const stated = dollarsIn(allText);
  const grounded = withDerivedCombinations(numbersInResults(toolResults));
  const derivable = derivableFromPrompt(c.turns.join(" "));

  const checks: CaseReport["checks"] = {};
  const check = (name: string, pass: boolean, note: string) => { checks[name] = { pass, note }; };

  if (error) {
    check("transport", false, error);
  } else if (!allText.trim()) {
    check("transport", false, "empty reply");
  } else {
    if (oracle && c.expect) {
      for (const { pe_variable, label } of c.expect) {
        const expected = oracle.pe_values[pe_variable];
        const candidates = [Math.round(expected), Math.floor(expected), Math.ceil(expected)];
        const hit = stated.some((n) => candidates.some((v) => Math.abs(n - v) <= oracle.tolerance));
        check(
          `value:${pe_variable}`,
          hit,
          hit ? `${label} matches oracle ${expected}` : `expected ${label} ≈ ${expected}; stated: ${stated.map((n) => `$${n}`).join(", ") || "none"}`
        );
      }
      const engineRan = toolCalls.some((t) => t.toolName === "compute" || t.toolName === "lookup_value");
      check("engine", engineRan, engineRan ? "compute/lookup ran" : "no engine call");
    }
    if (c.expect_amounts) {
      const hit = c.expect_amounts.some((amount) => stated.includes(amount));
      check("value", hit, hit ? `matches $${c.expect_amounts.join("/$")}` : `expected $${c.expect_amounts.join("/$")}; stated: ${stated.map((n) => `$${n}`).join(", ") || "none"}`);
    }
    if (!c.skip_grounding) {
      const invented = stated.filter((n) => !grounded.has(n) && !derivable.has(n) && n !== 0);
      check("grounded", invented.length === 0, invented.length ? `ungrounded: ${invented.map((n) => `$${n}`).join(", ")}` : "all figures grounded");
    }
    for (const source of c.expect_match ?? []) {
      const re = new RegExp(source, "i");
      check(`match:${source.slice(0, 24)}`, re.test(allText), re.test(allText) ? "matched" : `reply does not match /${source}/i`);
    }
    for (const source of c.expect_not_match ?? []) {
      const re = new RegExp(source, "i");
      check(`not:${source.slice(0, 24)}`, !re.test(allText), !re.test(allText) ? "clean" : `reply matches forbidden /${source}/i`);
    }
    const hadIncomplete = JSON.stringify(toolResults).includes("acknowledged_incomplete by the rulespec");
    check(
      "incomplete",
      !hadIncomplete || /incomplete|not fully encoded/i.test(allText),
      hadIncomplete ? "flag surfaced" : "n/a (no incomplete outputs)"
    );
    const budgetMs = c.budget_ms ?? DEFAULT_BUDGET_MS;
    const budgetSteps = c.budget_steps ?? DEFAULT_BUDGET_STEPS;
    check("budget", wall <= budgetMs && steps <= budgetSteps, `${(wall / 1000).toFixed(1)}s, ${steps} steps (budget ${budgetMs / 1000}s/${budgetSteps})`);
  }

  const pass = Object.values(checks).every((x) => x.pass);

  // -- Transcript ------------------------------------------------------------
  const lines: string[] = [];
  lines.push(`# ${c.id} — ${pass ? "PASS" : "FAIL"}`);
  lines.push(`\nmodel: ${turns[0]?.model ?? "unknown"}${oracle ? ` · oracle: ${oracle.program} (pe ${JSON.stringify(oracle.pe_values)})` : ""}`);
  lines.push(`wall: ${(wall / 1000).toFixed(1)}s · steps: ${steps}\n`);
  turns.forEach((turn, i) => {
    lines.push(`## Turn ${i + 1}\n\n> ${c.turns[i]}\n`);
    for (const e of turn.events) {
      if (e.kind === "9") {
        const p = e.payload as { toolName: string; args: unknown };
        lines.push(`**${(e.t / 1000).toFixed(1)}s → ${p.toolName}**\n\n\`\`\`json\n${JSON.stringify(p.args, null, 1)}\n\`\`\`\n`);
      }
      if (e.kind === "a") {
        const raw = JSON.stringify((e.payload as { result: unknown }).result, null, 1);
        lines.push(`result (${(e.t / 1000).toFixed(1)}s):\n\n\`\`\`json\n${raw.length > 2500 ? raw.slice(0, 2500) + "\n… truncated" : raw}\n\`\`\`\n`);
      }
    }
    lines.push(`### Reply\n\n${turn.text}\n`);
  });
  lines.push(`## Rubric\n`);
  for (const [name, x] of Object.entries(checks)) {
    lines.push(`- ${x.pass ? "✅" : "❌"} **${name}** — ${x.note}`);
  }
  writeFileSync(path.join(runDir, `${c.id}.md`), lines.join("\n"));

  return { id: c.id, wall_ms: wall, steps, tool_sequence: toolCalls.map((t) => t.toolName), checks, pass };
}

async function main() {
  const oracleDoc = JSON.parse(
    readFileSync(path.join(ROOT, "scripts", "oracle-cases.json"), "utf8")
  ) as OracleDoc;
  const oracleById = new Map(oracleDoc.cases.map((c) => [c.id, c]));

  const probe = await runTurn([{ role: "user", content: "hi" }]);
  const model = probe.model ?? "unknown-model";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(ROOT, "eval", "runs", `${stamp}-${model}`);
  mkdirSync(runDir, { recursive: true });
  console.log(`run: ${path.relative(ROOT, runDir)} (model ${model}) · ${CASES.length} cases\n`);

  const reports: CaseReport[] = [];
  for (const c of CASES) {
    const oracle = c.oracle_id ? oracleById.get(c.oracle_id) : undefined;
    if (c.oracle_id && !oracle) {
      console.log(`SKIP ${c.id}: oracle case ${c.oracle_id} not found`);
      continue;
    }
    const report = await evaluateCase(c, oracle, runDir);
    reports.push(report);
    const failed = Object.entries(report.checks).filter(([, x]) => !x.pass);
    console.log(
      `${report.pass ? "PASS" : "FAIL"} ${report.id.padEnd(24)} ${(report.wall_ms / 1000).toFixed(1).padStart(6)}s ${String(report.steps).padStart(2)} steps  ${report.tool_sequence.join("→") || "no tools"}`
    );
    for (const [name, x] of failed) console.log(`     ✗ ${name}: ${x.note}`);
  }

  writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({ model, base: BASE, pe_version: oracleDoc.pe_version, reports }, null, 1)
  );

  const failures = reports.filter((r) => !r.pass).length;
  const totalS = reports.reduce((s, r) => s + r.wall_ms, 0) / 1000;
  console.log(`\n${reports.length - failures}/${reports.length} passed · total ${totalS.toFixed(0)}s · transcripts in ${path.relative(ROOT, runDir)}`);
  process.exit(failures ? 1 : 0);
}

main();
