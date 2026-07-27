/**
 * LLM output evaluation — representative end-to-end cases.
 *
 * For each case the expected numbers were computed directly against the
 * engine via the request builder (same path the tools use), then the full
 * chat stack (/api/chat: system prompt + tools + model) is asked the natural-
 * language version and its answer is checked for:
 *
 *   - the right headline number (any of the acceptable engine values),
 *   - grounding: every dollar figure the model states must appear in some
 *     tool result on that turn (nothing recalled from training),
 *   - required phrases (incomplete flags, honesty about uncovered programs),
 *   - forbidden content (invented benefit amounts for uncovered programs).
 *
 * Requires a running app (bun run dev) with OPENAI_API_KEY set.
 *   FINBOT_EVAL_URL=http://localhost:3947 bun run eval:llm
 *
 * The model is nondeterministic — treat this as an eval harness, not CI.
 */

const BASE = process.env.FINBOT_EVAL_URL ?? "http://localhost:3947";

interface EvalCase {
  name: string;
  prompt: string;
  /** Acceptable headline values (engine-computed ground truth). */
  expect_amounts?: number[];
  /** Case-insensitive regexes that must match the reply text. */
  expect_match?: RegExp[];
  /** Case-insensitive regexes that must NOT match the reply text. */
  expect_not_match?: RegExp[];
  /** Require that a compute/lookup tool ran. */
  expect_engine_call?: boolean;
  /** Dollar figures in the reply must all be grounded in tool results. */
  check_grounding?: boolean;
}

const CASES: EvalCase[] = [
  {
    name: "md-tca-lookup",
    prompt: "What's the maximum TANF benefit for a family of 3 in Maryland?",
    // computeProgram(us-md-tca, {household_size: 3}) → 773
    expect_amounts: [773],
    expect_match: [/incomplete/i],
    expect_engine_call: true,
    check_grounding: true,
  },
  {
    name: "co-snap-max-allotment",
    prompt: "What's the maximum SNAP allotment for a household of 4 in Colorado?",
    // lookup snap_maximum_allotment @ household_size 4 → 994
    expect_amounts: [994],
    expect_engine_call: true,
    check_grounding: true,
  },
  {
    name: "ny-snap-calc",
    prompt:
      "I'm in New York with two kids, work 30 hrs/week at $16/hr, and pay $1,300/month rent. What would my SNAP benefit be?",
    // computeProgram(us-ny-snap, {household_size:3, earned 2078–2080, shelter 1300}) → 571–572.
    // PolicyEngine corroborates the same household at $572.30/mo (see
    // scripts/oracle-cases.json ny-snap-family3).
    expect_amounts: [571, 572],
    expect_engine_call: true,
    check_grounding: true,
  },
  {
    name: "co-snap-zero-income",
    prompt: "I'm single in Colorado with no income at all. How much SNAP would I get?",
    // Maximum-allotment case: engine and PolicyEngine both give $298/mo
    // (oracle-cases.json co-snap-single-max). Robust to defaults — at zero
    // income the shelter/utility facts can't change the answer.
    expect_amounts: [298],
    expect_engine_call: true,
    check_grounding: true,
  },
  {
    name: "ak-atap-max-payment",
    prompt: "What is the maximum ATAP payment for a family of 3 in Alaska?",
    // computeProgram(us-ak-tanf, {assistance_unit_size: 3}) → ak_atap_maximum_payment 923
    expect_amounts: [923],
    expect_engine_call: true,
    check_grounding: true,
  },
  {
    name: "wic-honesty",
    prompt: "How much WIC would I get for my newborn in Colorado?",
    // Any phrasing of "WIC isn't certified/encoded/among the certified
    // programs" counts; the point is refusing to invent a number.
    // Apostrophe class covers both ASCII ' and the typographic ’ models emit.
    expect_match: [/(hasn['’]?t|has not|isn['’]?t|is not|not)[^.]{0,80}(certif|encod)/i],
    check_grounding: true,
  },
];

interface TurnCapture {
  text: string;
  toolCalls: Array<{ toolName: string; args: unknown }>;
  toolResults: unknown[];
  error?: string;
}

async function runTurn(prompt: string): Promise<TurnCapture> {
  let r: Response;
  let body: string;
  try {
    r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
      // A hung upstream model stream must fail the case, not wedge the suite.
      signal: AbortSignal.timeout(240_000),
    });
    if (!r.ok) return { text: "", toolCalls: [], toolResults: [], error: `HTTP ${r.status}` };
    body = await r.text();
  } catch (err) {
    return { text: "", toolCalls: [], toolResults: [], error: `fetch failed: ${(err as Error).message}` };
  }
  const capture: TurnCapture = { text: "", toolCalls: [], toolResults: [] };
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 1) continue;
    const kind = line.slice(0, idx);
    const payload = line.slice(idx + 1);
    try {
      if (kind === "0") capture.text += JSON.parse(payload);
      else if (kind === "9") {
        const call = JSON.parse(payload);
        capture.toolCalls.push({ toolName: call.toolName, args: call.args });
      } else if (kind === "a") capture.toolResults.push(JSON.parse(payload).result);
      else if (kind === "3") capture.error = JSON.parse(payload);
    } catch {
      // tolerate partial lines
    }
  }
  return capture;
}

/** All whole-dollar figures stated in a text ($1,234 / $994). */
function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([\d,]+)(?:\.\d+)?/g)].map((m) => Number(m[1].replace(/,/g, "")));
}

/** Collect every number that appears anywhere in the tool results. */
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
    if (typeof v === "number") {
      out.add(Math.round(v));
      out.add(Math.floor(v));
      out.add(Math.ceil(v));
    } else if (typeof v === "string" && /^-?[\d.]+$/.test(v)) {
      out.add(Math.round(Number(v)));
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  results.forEach(visit);
  return out;
}

async function evaluate(c: EvalCase): Promise<{ pass: boolean; notes: string[] }> {
  const turn = await runTurn(c.prompt);
  const notes: string[] = [];
  let pass = true;

  if (turn.error) {
    return { pass: false, notes: [`stream error: ${turn.error}`] };
  }
  if (!turn.text.trim()) {
    return { pass: false, notes: ["empty reply (step budget exhausted?)"] };
  }

  const stated = dollarsIn(turn.text);
  const grounded = withDerivedCombinations(numbersInResults(turn.toolResults));

  if (c.expect_amounts) {
    const hit = c.expect_amounts.some((amount) => stated.includes(amount));
    if (!hit) {
      pass = false;
      notes.push(`expected one of $${c.expect_amounts.join("/$")} in reply; stated: ${stated.map((n) => `$${n}`).join(", ") || "none"}`);
    }
  }
  if (c.expect_engine_call) {
    const ran = turn.toolCalls.some((t) => t.toolName === "compute" || t.toolName === "lookup_value");
    if (!ran) {
      pass = false;
      notes.push(`no compute/lookup_value call (tools: ${turn.toolCalls.map((t) => t.toolName).join(", ")})`);
    }
  }
  if (c.check_grounding) {
    // Ignore figures the user themselves stated in the prompt, plus the
    // arithmetic derivations the system prompt requires the model to show
    // (hours × wage, weekly × 4.33 → monthly): products of prompt numbers
    // and their week→month conversions.
    const promptNumbers = [...c.prompt.matchAll(/\$?\s?([\d,]+(?:\.\d+)?)/g)].map((m) =>
      Number(m[1].replace(/,/g, ""))
    );
    const allowed = new Set<number>(promptNumbers.map(Math.round));
    for (const a of promptNumbers) {
      for (const b of promptNumbers) {
        for (const product of [a * b, a * b * 4.33]) {
          allowed.add(Math.round(product));
          allowed.add(Math.floor(product));
          allowed.add(Math.ceil(product));
        }
      }
      for (const conv of [a * 4.33]) {
        allowed.add(Math.round(conv));
        allowed.add(Math.floor(conv));
        allowed.add(Math.ceil(conv));
      }
    }
    const invented = stated.filter((n) => !grounded.has(n) && !allowed.has(n) && n !== 0);
    if (invented.length) {
      pass = false;
      notes.push(`ungrounded dollar figures in reply: ${invented.map((n) => `$${n}`).join(", ")}`);
    }
  }
  for (const re of c.expect_match ?? []) {
    if (!re.test(turn.text)) {
      pass = false;
      notes.push(`reply does not match ${re}`);
    }
  }
  for (const re of c.expect_not_match ?? []) {
    if (re.test(turn.text)) {
      pass = false;
      notes.push(`reply matches forbidden ${re}`);
    }
  }

  notes.push(`tools: ${turn.toolCalls.map((t) => t.toolName).join(" → ") || "none"}`);
  notes.push(`reply: ${turn.text.replace(/\s+/g, " ").slice(0, 220)}…`);
  return { pass, notes };
}

async function main() {
  console.log(`evaluating against ${BASE}\n`);
  let failures = 0;
  for (const c of CASES) {
    const started = Date.now();
    const { pass, notes } = await evaluate(c);
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"} ${c.name} (${Math.round((Date.now() - started) / 1000)}s)`);
    for (const note of notes) console.log(`     ${note}`);
    console.log();
  }
  console.log(failures === 0 ? `all ${CASES.length} cases passed` : `${failures}/${CASES.length} cases FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
