"use client";
import type { ToolInvocation } from "ai";
import { useState } from "react";

import { MarkdownText } from "./MarkdownText";
import { RunningPill } from "./RunningPill";
import { ToolCallCard } from "./ToolCallCard";

/**
 * One assistant turn: text reply on top, with a per-turn "show tool calls"
 * disclosure that expands the engine cards beneath. Tools are hidden by
 * default — the demo reads as a plain assistant answer and the engine work
 * is one click away if you want to see what was computed.
 */
export interface AssistantTurnProps {
  toolInvocations?: ToolInvocation[];
  text?: string;
  /** Indent the tool stack slightly — the chat uses this to align with bubbles. */
  indentTools?: boolean;
  /** Let the text bubble fill its container instead of capping at the bubble max-width. */
  fluid?: boolean;
  /** True while this turn's answer is still streaming in. The Sources footer
   *  is suppressed until streaming completes so it doesn't pop in mid-bubble. */
  isStreaming?: boolean;
}

export function AssistantTurn({
  toolInvocations,
  text,
  indentTools = false,
  fluid = false,
  isStreaming = false,
}: AssistantTurnProps) {
  const [expanded, setExpanded] = useState(false);
  const hasTools = !!toolInvocations && toolInvocations.length > 0;
  const hasText = !!text && text.trim().length > 0;
  if (!hasTools && !hasText) return null;

  return (
    <div className="flex flex-col gap-2">
      {/* Bridge the gap between tool-call rounds and the final text
          streaming in. While streaming, the per-turn tool disclosure
          and Sources are hidden; without this pill the bubble area is
          empty for several seconds and reads as "stuck". */}
      {isStreaming && !hasText && (
        <RunningPill label="running axiom-rules" />
      )}
      {hasTools && !isStreaming && (
        <div style={indentTools ? { marginLeft: 8 } : undefined}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mono"
            style={{
              fontSize: 11,
              color: "#6b7280",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              padding: "2px 0",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            {expanded ? "hide" : "show"} {toolInvocations!.length} tool call
            {toolInvocations!.length === 1 ? "" : "s"}
          </button>
          {expanded && (
            <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
              {toolInvocations!.map((inv) => (
                <ToolCallCard key={inv.toolCallId} invocation={inv} />
              ))}
            </div>
          )}
        </div>
      )}
      {hasText && (
        <div className="bubble bubble-assistant" style={fluid ? { maxWidth: "none" } : undefined}>
          <MarkdownText source={text!} />
        </div>
      )}
      {hasTools && !isStreaming && <Sources invocations={toolInvocations!} indented={indentTools} />}
    </div>
  );
}

interface CitationLike {
  legal_id: string;
  url: string;
}

/** Pull citation links out of every tool result on this turn. compute_co_snap
 *  returns `citations: [{id, url}]`; lookup_value returns `{legal_id, url}`;
 *  fetch_citation returns `{legal_id, url}`. We dedupe by legal_id and render
 *  a small footer below the bubble.
 *
 *  When there are more than INLINE_SOURCE_LIMIT citations (compute_co_snap can
 *  surface ~28 — every regulation the rule chain touches), the inline list is
 *  collapsed behind a "show N sources" disclosure to keep the chat surface
 *  uncluttered. Single-source answers (like lookup_value) stay inline. */
const INLINE_SOURCE_LIMIT = 3;

function Sources({ invocations, indented }: { invocations: ToolInvocation[]; indented: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const seen = new Set<string>();
  const citations: CitationLike[] = [];
  for (const inv of invocations) {
    const r = "result" in inv ? (inv.result as Record<string, unknown> | undefined) : undefined;
    if (!r || typeof r !== "object") continue;
    if (inv.toolName === "compute_co_snap" && Array.isArray(r.citations)) {
      for (const c of r.citations as Array<{ id?: string; url?: string }>) {
        if (c?.id && c.url && !seen.has(c.id)) {
          seen.add(c.id);
          citations.push({ legal_id: c.id, url: c.url });
        }
      }
    } else if ((inv.toolName === "lookup_value" || inv.toolName === "fetch_citation") && typeof r.legal_id === "string" && typeof r.url === "string") {
      const id = r.legal_id.split("#")[0];
      if (!seen.has(id)) {
        seen.add(id);
        citations.push({ legal_id: id, url: r.url });
      }
    }
  }
  if (citations.length === 0) return null;

  const overflow = citations.length > INLINE_SOURCE_LIMIT;
  const visible = expanded || !overflow ? citations : citations.slice(0, INLINE_SOURCE_LIMIT);

  return (
    <div
      style={{
        marginTop: 6,
        paddingLeft: indented ? 8 : 0,
        fontSize: 11,
        color: "#6b7280",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: "2px 6px",
      }}
    >
      <span className="mono" style={{ marginRight: 2 }}>Sources:</span>
      {visible.map((c, i) => (
        <span key={c.legal_id} style={{ display: "inline-flex", alignItems: "baseline" }}>
          <a className="cite" href={c.url} target="_blank" rel="noreferrer">
            {c.legal_id}
          </a>
          {i < visible.length - 1 && <span style={{ marginLeft: 2 }}>,</span>}
        </span>
      ))}
      {overflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mono"
          style={{
            background: "transparent",
            border: 0,
            cursor: "pointer",
            padding: 0,
            color: "#6b7280",
            fontSize: 11,
            textDecoration: "underline",
            textUnderlineOffset: 3,
          }}
        >
          {expanded ? "show fewer" : `show ${citations.length - INLINE_SOURCE_LIMIT} more`}
        </button>
      )}
    </div>
  );
}
