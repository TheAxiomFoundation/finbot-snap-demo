"use client";
import type { ToolInvocation } from "ai";

import { MarkdownText } from "./MarkdownText";
import { ToolCallCard } from "./ToolCallCard";

/**
 * One assistant turn: tool calls render first (what the model "did"),
 * the text reply renders below (what it "said"). Used by both the FinBot
 * chat surface and the Side-by-side comparison so any improvement to
 * tool-card rendering or markdown formatting flows to both at once.
 */
export interface AssistantTurnProps {
  toolInvocations?: ToolInvocation[];
  text?: string;
  /** Hide the tool stack (the chat has a "show/hide tool calls" toggle). */
  showTools?: boolean;
  /** Indent the tool stack slightly — the chat uses this to align with bubbles. */
  indentTools?: boolean;
  /** Let the text bubble fill its container instead of capping at the bubble max-width. */
  fluid?: boolean;
}

export function AssistantTurn({
  toolInvocations,
  text,
  showTools = true,
  indentTools = false,
  fluid = false,
}: AssistantTurnProps) {
  const hasTools = showTools && !!toolInvocations && toolInvocations.length > 0;
  const hasText = !!text && text.trim().length > 0;
  if (!hasTools && !hasText) return null;
  return (
    <div className="flex flex-col gap-2">
      {hasTools && (
        <div className="flex flex-col gap-2" style={indentTools ? { marginLeft: 8 } : undefined}>
          {toolInvocations!.map((inv) => (
            <ToolCallCard key={inv.toolCallId} invocation={inv} />
          ))}
        </div>
      )}
      {hasText && (
        <div className="bubble bubble-assistant" style={fluid ? { maxWidth: "none" } : undefined}>
          <MarkdownText source={text!} />
        </div>
      )}
    </div>
  );
}
