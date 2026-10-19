/**
 * The claim verifier: every dollar figure a reply states must trace to a
 * number a tool actually returned, a number in the user's own prompt (with
 * obvious period conversions), or a simple arithmetic combination of those —
 * or be exactly zero. This is the eval harness's `grounded` check
 * (eval/oracle-eval.ts), promoted from a test-only predicate to a function
 * both the eval and the live route call, so the two never drift apart.
 */

export function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([\d,]+)(?:\.\d+)?/g)].map((m) => Number(m[1].replace(/,/g, "")));
}

export function numbersInResults(results: unknown[]): Set<number> {
  const out = new Set<number>();
  const visit = (v: unknown) => {
    if (typeof v === "number") {
      out.add(Math.round(v));
      out.add(Math.floor(v));
      out.add(Math.ceil(v));
    } else if (typeof v === "string" && /^-?[\d.]+$/.test(v)) {
      out.add(Math.round(Number(v)));
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(visit);
    }
  };
  results.forEach(visit);
  return out;
}

/** Extend grounded numbers with simple shown-arithmetic combinations the
 *  reply may legitimately derive from them: pairwise sums/differences, the
 *  SNAP 30%-of-net figure, and per-unit divisions by small member counts
 *  ("$4,400 across 2 qualifying children" → $2,200). */
export function withDerivedCombinations(grounded: Set<number>): Set<number> {
  const out = new Set(grounded);
  const values = [...grounded].filter((n) => n >= 1 && n <= 1_000_000);
  const cap = 250; // avoid quadratic blowup on huge result sets
  const sample = values.slice(0, cap);
  for (const a of sample) {
    out.add(Math.round(a * 0.3));
    out.add(Math.ceil(a * 0.3));
    out.add(Math.floor(a * 0.3));
    for (const count of [2, 3, 4, 5, 6, 12]) out.add(Math.round(a / count));
    for (const b of sample) {
      out.add(Math.abs(Math.round(a - b)));
      out.add(Math.round(a + b));
    }
  }
  return out;
}

export function derivableFromPrompt(prompt: string): Set<number> {
  const numbers = [...prompt.matchAll(/\$?\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  const allowed = new Set<number>(numbers.map(Math.round));
  for (const a of numbers) {
    for (const b of numbers) {
      for (const p of [a * b, a * b * 4.33]) {
        allowed.add(Math.round(p));
        allowed.add(Math.floor(p));
        allowed.add(Math.ceil(p));
      }
    }
    for (const c of [a * 4.33, a * 12, a / 12]) {
      allowed.add(Math.round(c));
      allowed.add(Math.floor(c));
      allowed.add(Math.ceil(c));
    }
  }
  return allowed;
}

export interface GroundingCheck {
  stated: number[];
  invented: number[];
  grounded: boolean;
}

/** Every dollar figure in `text` must be traceable to `toolResults` or
 *  `promptText` (or a simple derived combination of either) — or be zero.
 *  Non-blocking by design: callers log/annotate `invented`, they don't use
 *  it to withhold the reply. */
export function checkGrounding(text: string, toolResults: unknown[], promptText: string): GroundingCheck {
  const stated = dollarsIn(text);
  const grounded = withDerivedCombinations(numbersInResults(toolResults));
  const derivable = derivableFromPrompt(promptText);
  const invented = stated.filter((n) => !grounded.has(n) && !derivable.has(n) && n !== 0);
  return { stated, invented, grounded: invented.length === 0 };
}
