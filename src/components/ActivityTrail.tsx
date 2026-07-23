"use client";
import type { ToolInvocation } from "ai";

/**
 * Live under-the-hood activity while an assistant turn is streaming: one line
 * per tool call, phrased as a human-readable step, with completed steps
 * checked off and the current one animated. Replaces the generic
 * "running axiom-rules-engine" pill with the real chain of work.
 */

/** Model-written tool arguments render into these labels; a glitched call
 *  (e.g. a system-prompt echo in `program`) must not flood the trail. */
function clip(s: string, max = 48): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** Both wordings for a step, derived from args only — the running/done split
 *  is applied per GROUP in the collapse below, so a step's identity (and the
 *  ×N grouping) never changes as its state flips. */
function stepPhrases(inv: ToolInvocation): { running: string; done: string } {
  const args = (inv.args ?? {}) as Record<string, unknown>;
  const program = typeof args.program === "string" ? clip(args.program) : null;
  switch (inv.toolName) {
    case "list_programs": {
      if (typeof args.search === "string" && args.search) {
        const s = clip(args.search);
        return { running: `searching certified outputs for “${s}”`, done: `searched certified outputs for “${s}”` };
      }
      return { running: "checking the certified-program catalog", done: "checked the certified-program catalog" };
    }
    case "describe_program": {
      const filter = typeof args.inputs_search === "string" && args.inputs_search ? clip(args.inputs_search) : null;
      if (filter)
        return {
          running: `scanning ${program ?? "program"} inputs for “${filter}”`,
          done: `scanned ${program ?? "program"} inputs for “${filter}”`,
        };
      return {
        running: `reading the ${program ?? "program"} rule schema`,
        done: `read the ${program ?? "program"} rule schema`,
      };
    }
    case "compute":
      return {
        running: `running ${program ?? "the program"} in the rules engine`,
        done: `computed ${program ?? "the program"} in the rules engine`,
      };
    case "lookup_value": {
      const output = typeof args.output === "string" ? clip(args.output) : "a value";
      return { running: `looking up ${output}`, done: `looked up ${output}` };
    }
    case "fetch_citation": {
      const id = typeof args.legal_id === "string" ? clip(args.legal_id, 64) : "the legal source";
      return { running: `fetching ${id}`, done: `fetched ${id}` };
    }
    default:
      return { running: `running ${inv.toolName}`, done: inv.toolName };
  }
}

export function ActivityTrail({
  invocations,
  settled = false,
}: {
  invocations: ToolInvocation[];
  /** True once the final answer text has started streaming — suppresses the
   *  "reading the results" trailer since the results have clearly been read. */
  settled?: boolean;
}) {
  if (invocations.length === 0) return null;
  // Between a tool result landing and the model's next move (another call or
  // the final text) nothing is technically in flight — without a trailing
  // line the trail reads as hung. Model-thinking time dominates those gaps.
  const allDone = invocations.every((inv) => inv.state === "result");

  // Collapse consecutive steps with the same settled wording into one line
  // with a ×N counter. Grouping keys on the DONE phrasing (state-independent)
  // so lines never split, merge, or re-key as a step's state flips — only the
  // wording of the group flips once, when its last member completes.
  const steps: Array<{ key: string; label: string; done: boolean; count: number }> = [];
  let lastSig: string | null = null;
  for (const inv of invocations) {
    const phrases = stepPhrases(inv);
    const done = inv.state === "result";
    const last = steps[steps.length - 1];
    if (last && lastSig === phrases.done) {
      last.count++;
      last.done = last.done && done;
      last.label = last.done ? phrases.done : phrases.running;
    } else {
      steps.push({ key: inv.toolCallId, label: done ? phrases.done : phrases.running, done, count: 1 });
      lastSig = phrases.done;
    }
  }

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 14px",
        background: "#fafaf6",
        border: "1px solid #e6e6df",
        borderRadius: 12,
        alignSelf: "flex-start",
      }}
    >
      {steps.map((step) => (
        <div
          key={step.key}
          className="mono"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 7,
            fontSize: 11.5,
            color: step.done ? "#9ca3af" : "#374151",
          }}
        >
          <span style={{ width: 10, textAlign: "center", color: step.done ? "#059669" : "#92400e" }}>
            {step.done ? "✓" : "•"}
          </span>
          <span>
            {step.label}
            {step.count > 1 ? ` ×${step.count}` : ""}
          </span>
          {!step.done && (
            <span className="thinking-dots" aria-hidden="true">
              <span /><span /><span />
            </span>
          )}
        </div>
      ))}
      {allDone && !settled && (
        <div
          className="mono"
          style={{ display: "flex", alignItems: "baseline", gap: 7, fontSize: 11.5, color: "#374151" }}
        >
          <span style={{ width: 10, textAlign: "center", color: "#92400e" }}>•</span>
          <span>reading the results</span>
          <span className="thinking-dots" aria-hidden="true">
            <span /><span /><span />
          </span>
        </div>
      )}
    </div>
  );
}
