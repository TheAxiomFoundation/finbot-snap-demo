/**
 * Oracle prompt-review harness. See eval/README.md.
 *
 * Runs the natural-language version of every PolicyEngine oracle case
 * (scripts/oracle-cases.json) through the full chat stack, captures the
 * complete transcript with timings, applies the review rubric, and archives
 * everything under eval/runs/<timestamp>-<model>/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.join(import.meta.dirname ?? __dirname, ".."));
const BASE = process.env.FINBOT_EVAL_URL ?? "http://localhost:3947";
const DEFAULT_BUDGET_MS = 30_000;
const BUDGET_STEPS = 6;
// FIIT legitimately carries heavy member payloads across a fix-and-recompute
// loop; the SNAP cases should stay tight.
const CASE_BUDGET_MS: Record<string, number> = { "fiit-mfj-2kids": 50_000 };

// ---------------------------------------------------------------------------
// Natural-language framings of the oracle scenarios. Facts a real user could
// plausibly state; each maps to one case in scripts/oracle-cases.json whose
// engine/PolicyEngine-agreed values are the ground truth.
// ---------------------------------------------------------------------------
const PROMPTS: Record<string, { prompt: string; expect: Array<{ pe_variable: string; label: string }> }> = {
  "ny-snap-family3": {
    prompt:
      "I'm a single parent in New York with two kids (8 and 5). I earn $2,078 a month, my rent is $1,300, and I pay heating separately from rent. What SNAP would we get?",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  "co-snap-single-max": {
    prompt: "I live alone in Colorado and currently have no income at all. How much SNAP can I get?",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  "ca-snap-family4": {
    prompt:
      "We're a married couple in California with kids aged 6 and 4. I earn $2,500/month, our rent is $1,800, and we pay heating and cooling separately from rent. What would our CalFresh benefit be?",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  "az-snap-elderly": {
    prompt:
      "I'm 67, live alone in Arizona on $1,200 a month of Social Security. My rent is $900 and my utility allowance is $323. Am I eligible for SNAP and how much?",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  "fiit-mfj-2kids": {
    prompt:
      "Married filing jointly, two kids (8 and 5) with valid SSNs who live with us all year. Taxable income $62,800 on $95,000 of wages. What's our 2026 federal income tax before credits, and our child tax credit?",
    expect: [
      { pe_variable: "income_tax_main_rates", label: "tax before credits" },
      { pe_variable: "ctc_value", label: "child tax credit" },
    ],
  },
  "co-tanf-family3": {
    prompt:
      "I'm a single mom with two kids in Colorado and no income right now. How much Colorado Works cash assistance could I get per month?",
    expect: [{ pe_variable: "co_tanf", label: "monthly TANF" }],
  },
  "ma-snap-parent-1kid": {
    prompt:
      "I live in Massachusetts with my 4-year-old, earn $1,500 a month, pay $1,400 rent plus heat separately. We're both US citizens. What SNAP would we get?",
    expect: [{ pe_variable: "snap", label: "monthly SNAP" }],
  },
  "fiit-eitc-hoh-2kids": {
    prompt:
      "I file as head of household with two kids, 8 and 5, who live with me all year and have SSNs. I earned $18,000 in wages in 2026. How much EITC do I get?",
    expect: [{ pe_variable: "eitc", label: "EITC" }],
  },
};

// ---------------------------------------------------------------------------

interface OracleDoc {
  pe_version: string;
  cases: Array<{
    id: string;
    program: string;
    tolerance: number;
    pe_values: Record<string, number>;
  }>;
}

interface StreamEvent {
  t: number;
  kind: string;
  payload: unknown;
}

async function runTurn(prompt: string): Promise<{
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
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
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
    // Timeout/abort mid-stream: keep whatever we captured, mark the error.
    return { events, text, model, error: `stream aborted: ${(err as Error).message}` };
  }
  return { events, text, model };
}

function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([\d,]+)(?:\.\d+)?/g)].map((m) => Number(m[1].replace(/,/g, "")));
}

/** Extend grounded numbers with simple shown-arithmetic combinations the
 *  reply may legitimately derive from them: pairwise sums/differences and the
 *  SNAP 30%-of-net figure. */
function withDerivedCombinations(grounded: Set<number>): Set<number> {
  const out = new Set(grounded);
  const values = [...grounded].filter((n) => n >= 1 && n <= 1_000_000);
  const cap = 250; // avoid quadratic blowup on huge result sets
  const sample = values.slice(0, cap);
  for (const a of sample) {
    out.add(Math.round(a * 0.3));
    out.add(Math.ceil(a * 0.3));
    out.add(Math.floor(a * 0.3));
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
  id: string,
  oracle: OracleDoc["cases"][number],
  runDir: string
): Promise<CaseReport> {
  const spec = PROMPTS[id];
  const started = Date.now();
  const turn = await runTurn(spec.prompt);
  const wall = Date.now() - started;

  const toolCalls = turn.events.filter((e) => e.kind === "9").map((e) => e.payload as { toolName: string; args: unknown });
  const toolResults = turn.events.filter((e) => e.kind === "a").map((e) => (e.payload as { result: unknown }).result);
  const steps = turn.events.filter((e) => e.kind === "e").length;

  const stated = dollarsIn(turn.text);
  const grounded = withDerivedCombinations(numbersInResults(toolResults));
  const derivable = derivableFromPrompt(spec.prompt);

  const checks: CaseReport["checks"] = {};
  const check = (name: string, pass: boolean, note: string) => { checks[name] = { pass, note }; };

  if (turn.error) {
    check("value", false, turn.error);
  } else {
    for (const { pe_variable, label } of spec.expect) {
      const expected = oracle.pe_values[pe_variable];
      const candidates = [Math.round(expected), Math.floor(expected), Math.ceil(expected)];
      const hit = stated.some((n) => candidates.some((c) => Math.abs(n - c) <= oracle.tolerance));
      check(
        `value:${pe_variable}`,
        hit,
        hit
          ? `${label} matches oracle ${expected}`
          : `expected ${label} ≈ ${expected}; reply stated: ${stated.map((n) => `$${n}`).join(", ") || "none"}`
      );
    }
    const engineRan = toolCalls.some((t) => t.toolName === "compute" || t.toolName === "lookup_value");
    check("engine", engineRan, engineRan ? "compute/lookup ran" : "no engine call");
    const invented = stated.filter((n) => !grounded.has(n) && !derivable.has(n) && n !== 0);
    check("grounded", invented.length === 0, invented.length ? `ungrounded: ${invented.map((n) => `$${n}`).join(", ")}` : "all figures grounded");
    check("assumptions", /assumption/i.test(turn.text), "Assumptions section present");
    check("period", /2026/.test(turn.text), "period stated");
    const hadIncomplete = JSON.stringify(toolResults).includes("acknowledged_incomplete by the rulespec");
    check(
      "incomplete",
      !hadIncomplete || /incomplete|not fully encoded/i.test(turn.text),
      hadIncomplete ? "flag surfaced" : "n/a (no incomplete outputs)"
    );
    const budgetMs = CASE_BUDGET_MS[id] ?? DEFAULT_BUDGET_MS;
    check("budget", wall <= budgetMs && steps <= BUDGET_STEPS, `${(wall / 1000).toFixed(1)}s, ${steps} steps (budget ${budgetMs / 1000}s/${BUDGET_STEPS})`);
  }

  const pass = Object.values(checks).every((c) => c.pass);

  // -- Transcript ------------------------------------------------------------
  const lines: string[] = [];
  lines.push(`# ${id} — ${pass ? "PASS" : "FAIL"}`);
  lines.push(`\nmodel: ${turn.model ?? "unknown"} · oracle: ${oracle.program} (pe ${JSON.stringify(oracle.pe_values)})`);
  lines.push(`wall: ${(wall / 1000).toFixed(1)}s · steps: ${steps}\n`);
  lines.push(`## Prompt\n\n> ${spec.prompt}\n`);
  lines.push(`## Tool calls\n`);
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
  lines.push(`## Reply\n\n${turn.text}\n`);
  lines.push(`## Rubric\n`);
  for (const [name, c] of Object.entries(checks)) {
    lines.push(`- ${c.pass ? "✅" : "❌"} **${name}** — ${c.note}`);
  }
  writeFileSync(path.join(runDir, `${id}.md`), lines.join("\n"));

  return {
    id,
    wall_ms: wall,
    steps,
    tool_sequence: toolCalls.map((t) => t.toolName),
    checks,
    pass,
  };
}

async function main() {
  const oracleDoc = JSON.parse(
    readFileSync(path.join(ROOT, "scripts", "oracle-cases.json"), "utf8")
  ) as OracleDoc;

  // Probe the model name for the run directory.
  const probe = await runTurn("hi");
  const model = probe.model ?? "unknown-model";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(ROOT, "eval", "runs", `${stamp}-${model}`);
  mkdirSync(runDir, { recursive: true });
  console.log(`run: ${path.relative(ROOT, runDir)} (model ${model})\n`);

  const reports: CaseReport[] = [];
  for (const oracleCase of oracleDoc.cases) {
    if (!PROMPTS[oracleCase.id]) continue;
    const report = await evaluateCase(oracleCase.id, oracleCase, runDir);
    reports.push(report);
    const failed = Object.entries(report.checks).filter(([, c]) => !c.pass);
    console.log(
      `${report.pass ? "PASS" : "FAIL"} ${report.id.padEnd(22)} ${(report.wall_ms / 1000).toFixed(1).padStart(5)}s ${String(report.steps).padStart(2)} steps  ${report.tool_sequence.join("→")}`
    );
    for (const [name, c] of failed) console.log(`     ✗ ${name}: ${c.note}`);
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
