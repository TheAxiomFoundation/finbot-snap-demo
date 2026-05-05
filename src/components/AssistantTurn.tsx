"use client";
import type { ToolInvocation } from "ai";

import { StructuredResponse, type StructuredArgs } from "./StructuredResponse";
import { ToolCallCard } from "./ToolCallCard";

/**
 * One assistant turn. Tool cards render first (what the model "did"), then a
 * structured response renders below (what the harness produced).
 *
 * Harness ownership of the response. The model picks the shape via the
 * `respond` tool's `kind` field, and we build the headline from the engine
 * tool results — never from a model-supplied string. That's how the harness
 * prevents the "model puts $785 (max allotment) in the headline instead of
 * $667 (regular allotment)" failure mode: the model has no opportunity to
 * pick the wrong field, because it doesn't pick the number at all.
 */
export interface AssistantTurnProps {
  toolInvocations?: ToolInvocation[];
  /** Falls back to free-form text when the model didn't call respond. Useful
   *  for the raw side of the side-by-side comparison (no harness, no tools). */
  fallbackText?: string;
  /** Hide the tool stack (the chat has a "show/hide tool calls" toggle). */
  showTools?: boolean;
  /** Indent the tool stack slightly — the chat uses this to align with bubbles. */
  indentTools?: boolean;
  /** Let any rendered bubble fill its container instead of capping at the
   *  bubble max-width. */
  fluid?: boolean;
}

export function AssistantTurn({
  toolInvocations,
  fallbackText,
  showTools = true,
  indentTools = false,
  fluid = false,
}: AssistantTurnProps) {
  const hasTools = !!toolInvocations && toolInvocations.length > 0;

  // Find the most recent respond/decline call — that drives the rendered reply.
  const responseCall = hasTools
    ? toolInvocations!
        .slice()
        .reverse()
        .find((inv) => inv.toolName === "respond" || inv.toolName === "decline_out_of_scope")
    : undefined;

  const renderedFromResponse = responseCall && hasTools
    ? buildStructuredArgs(responseCall, toolInvocations!)
    : undefined;

  // The "engine" tools — everything except the response harness ones — render
  // as cards above the structured reply so the user can see what was computed.
  const engineCalls = hasTools
    ? toolInvocations!.filter((inv) => inv.toolName !== "respond" && inv.toolName !== "decline_out_of_scope")
    : [];

  const showFallback = !renderedFromResponse && fallbackText && fallbackText.trim().length > 0;

  if (engineCalls.length === 0 && !renderedFromResponse && !showFallback) return null;

  return (
    <div className="flex flex-col gap-2">
      {showTools && engineCalls.length > 0 && (
        <div className="flex flex-col gap-2" style={indentTools ? { marginLeft: 8 } : undefined}>
          {engineCalls.map((inv) => (
            <ToolCallCard key={inv.toolCallId} invocation={inv} />
          ))}
        </div>
      )}
      {renderedFromResponse && <StructuredResponse args={renderedFromResponse} />}
      {showFallback && (
        <div className="bubble bubble-assistant" style={fluid ? { maxWidth: "none" } : undefined}>
          {fallbackText}
        </div>
      )}
    </div>
  );
}

interface RawArgs {
  // shared
  assumptions?: Array<{ key: string; value: string }>;
  what_could_change?: Array<{ label: string; detail: string }>;
  action?: string;
  // respond
  kind?: "household_benefit" | "parameter_value" | "free_form";
  custom_headline?: string;
  parameter_label?: string;
  // decline
  headline?: string;
  body?: string;
}

function fmt(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

const ELIGIBILITY_LABELS: Record<string, string> = {
  snap_resource_eligible: "resource",
  snap_income_eligible: "income",
  snap_work_requirement_eligible: "work-requirement",
  snap_residency_citizenship_eligible: "residency / citizenship",
};

/** Build the rendered structured args. The headline is constructed from
 *  engine results, NOT from a model-provided string, so the model can't
 *  introduce wrong numbers no matter what. */
function buildStructuredArgs(
  responseCall: ToolInvocation,
  allInvocations: ToolInvocation[]
): StructuredArgs | undefined {
  const args = ("args" in responseCall ? responseCall.args : undefined) as RawArgs | undefined;
  if (!args) return undefined;

  // Decline tool: the execute() result is the source of truth (the tool itself
  // composed a fixed message), so we render that directly.
  if (responseCall.toolName === "decline_out_of_scope") {
    const result = "result" in responseCall ? (responseCall.result as RawArgs | undefined) : undefined;
    const r = result ?? args;
    return {
      headline: stripBold(r.headline ?? "—"),
      body: r.body,
      action: r.action,
    };
  }

  // Respond tool: build the headline from engine tool results based on `kind`.
  const headline = buildHeadline(args, allInvocations);
  return {
    headline,
    assumptions: args.assumptions,
    what_could_change: args.what_could_change,
    action: args.action,
  };
}

function buildHeadline(args: RawArgs, allInvocations: ToolInvocation[]): string {
  const kind = args.kind ?? "free_form";

  if (kind === "household_benefit") {
    // Read the canonical fields from the most recent compute_co_snap result.
    const compute = lastResultOfKind(allInvocations, "compute_co_snap") as
      | { outputs?: Record<string, unknown> }
      | undefined;
    const o = compute?.outputs ?? {};
    if (o.snap_eligible === "not_holds") {
      const failing = Object.keys(ELIGIBILITY_LABELS).find((k) => o[k] === "not_holds");
      const label = failing ? ELIGIBILITY_LABELS[failing] : "eligibility";
      return `Not eligible — the ${label} test failed.`;
    }
    if (typeof o.snap_regular_month_allotment === "number") {
      return `You'd qualify for ${fmt(o.snap_regular_month_allotment)}/month in Colorado SNAP.`;
    }
    return "(no compute_co_snap result available)";
  }

  if (kind === "parameter_value") {
    // Read the value from the most recent lookup_value result.
    const lookup = lastResultOfKind(allInvocations, "lookup_value") as
      | { value?: number | string; unit?: string | null; name?: string }
      | undefined;
    if (lookup) {
      const label = args.parameter_label ?? lookup.name ?? "parameter";
      if (typeof lookup.value === "number") {
        const isMoney = !lookup.unit || lookup.unit === "USD";
        const formatted = isMoney ? fmt(lookup.value) : `${lookup.value} ${lookup.unit}`;
        return `The ${label} is ${formatted}.`;
      }
      if (lookup.value === "holds" || lookup.value === "not_holds") {
        return `${label}: ${lookup.value === "holds" ? "yes" : "no"}.`;
      }
    }
    return "(no lookup_value result available)";
  }

  // free_form fallback — only when neither engine path applies.
  return stripBold(args.custom_headline ?? "—");
}

function lastResultOfKind(invocations: ToolInvocation[], toolName: string): unknown {
  for (let i = invocations.length - 1; i >= 0; i--) {
    const inv = invocations[i];
    if (inv.toolName !== toolName) continue;
    if ("result" in inv) return inv.result;
  }
  return undefined;
}

function stripBold(s: string): string {
  return s.replace(/^\*\*([^*]+)\*\*$/, "$1");
}
