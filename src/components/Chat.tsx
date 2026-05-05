"use client";
import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";

import { AssistantTurn } from "./AssistantTurn";

const STARTERS = [
  "I live in Colorado, single mom of two kids, work part-time at $15.50/hr for 25 hours a week. About $500/month rent. Will I get SNAP?",
  "What's the maximum SNAP allotment for a household of 4 in Colorado right now?",
  "I'm 65, retired, $900/month from Social Security, $200 in checking. Anything I'd qualify for?",
];

export function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, error, setInput } = useChat({
    api: "/api/chat",
    maxSteps: 6,
    onError(err) {
      // Surface real reason in the browser console for diagnosis.
      console.error("[finbot] chat error:", err);
    },
  });
  const [showSources, setShowSources] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Resize the textarea whenever `input` changes — including programmatic
  // updates from the starter buttons. The inline onChange only fires for
  // user typing, so without this the box stays one line until you focus it.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  return (
    <div className="flex flex-col gap-4">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {STARTERS.map((s, i) => (
          <button
            key={i}
            type="button"
            className="btn btn-ghost"
            style={{
              fontSize: 12,
              fontWeight: 500,
              textAlign: "left",
              lineHeight: 1.4,
              whiteSpace: "normal",
              padding: "10px 12px",
              height: "auto",
            }}
            onClick={() => setInput(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12 }}
          onClick={() => setShowSources((v) => !v)}
        >
          {showSources ? "hide" : "show"} tool calls
        </button>
      </div>

      <div className="card" style={{ minHeight: 480 }}>
        {messages.length === 0 && (
          <div className="text-sm" style={{ color: "#6b7280" }}>
            Ask anything about Colorado SNAP. Every dollar amount and eligibility verdict
            below comes from a real <span className="mono">axiom-rules</span> compute.
          </div>
        )}
        <div className="flex flex-col gap-3">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="bubble bubble-user">
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            ) : (
              <AssistantTurn
                key={m.id}
                toolInvocations={m.toolInvocations}
                text={m.content}
                showTools={showSources}
                indentTools
              />
            )
          )}
          {isLoading && (
            <div className="bubble bubble-assistant">
              <span className="mono" style={{ fontSize: 12, color: "#6b7280" }}>
                thinking · running axiom-rules…
              </span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="card" style={{ background: "#fee2e2", borderColor: "#fca5a5" }}>
          <div className="text-sm" style={{ color: "#991b1b" }}>
            <strong>Chat error:</strong> {error.message}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="input-pill" style={{ alignItems: "flex-end" }}>
        <textarea
          ref={textareaRef}
          name="prompt"
          value={input}
          onChange={(e) => handleInputChange(e as unknown as React.ChangeEvent<HTMLInputElement>)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (input.trim() && !isLoading) {
                (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
              }
            }
          }}
          placeholder="Ask about SNAP eligibility or amount in Colorado…"
          autoComplete="off"
          rows={1}
          style={{
            flex: 1,
            border: 0,
            outline: 0,
            background: "transparent",
            fontSize: 14.5,
            fontFamily: "inherit",
            resize: "none",
            lineHeight: 1.5,
            padding: 0,
            minHeight: "1.5em",
            maxHeight: 160,
            overflowY: "auto",
          }}
        />
        <button type="submit" className="btn" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
