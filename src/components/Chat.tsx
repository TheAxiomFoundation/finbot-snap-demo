"use client";
import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";

import { INPUT_PLACEHOLDER } from "@/lib/copy";
import { STARTERS } from "@/lib/starters";

import { AssistantTurn } from "./AssistantTurn";
import { MarkdownText } from "./MarkdownText";
import { RunningPill } from "./RunningPill";

export function Chat() {
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    error,
    setInput,
    setMessages,
    append,
  } = useChat({
    api: "/chatbot/api/chat",
    maxSteps: 12,
    onError(err) {
      console.error("[finbot] chat error:", err);
    },
  });

  const [compareMode, setCompareMode] = useState(false);
  /** Raw-LLM responses keyed by the id of the user message they answer.
   *  null = pending (request in flight); string = completed text; absent = no
   *  request was made (compare mode was off when the user submitted). */
  const [rawResponses, setRawResponses] = useState<Record<string, string | null>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Resize the textarea whenever `input` changes — including programmatic
  // updates from the starter buttons.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  /** Fire a /api/raw call for compare mode. The axiom side flows through
   *  useChat normally; we just fan out a parallel raw fetch and stash the
   *  result keyed by the latest user message id. */
  async function fanOutRaw(messagesForRaw: Array<{ role: string; content: string }>, userMsgId: string) {
    setRawResponses((m) => ({ ...m, [userMsgId]: null }));
    try {
      const r = await fetch("/chatbot/api/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messagesForRaw }),
      });
      const json = (await r.json()) as { text?: string; error?: string };
      setRawResponses((m) => ({ ...m, [userMsgId]: json.text ?? `error: ${json.error ?? "no text"}` }));
    } catch (e) {
      setRawResponses((m) => ({ ...m, [userMsgId]: `error: ${String(e)}` }));
    }
  }

  function submitMessage(content: string, options: { reset?: boolean } = {}) {
    if (!content.trim()) return;
    if (options.reset) setMessages([]);
    setInput("");
    void append({ role: "user", content }).then((id) => {
      // append returns the full id of the assistant turn it kicks off; the
      // user message id we want is the last user message in state.
      // We capture it after state settles by reading messages on the next tick.
      // (See effect below — fanOutRaw fires when a new user message is added
      // in compareMode.)
      void id;
    });
  }

  // When a new user message is added AND compareMode is on, fire the raw
  // fetch. The raw side gets its OWN conversation history — user messages
  // plus its own previous raw replies — so the comparison stays fair. The
  // axiom-grounded assistant replies (the right-hand column) are NOT fed
  // into the raw side; otherwise the plain LLM would get to read the
  // engine-grounded answers as context for follow-ups.
  useEffect(() => {
    if (!compareMode) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") return;
    if (rawResponses[last.id] !== undefined) return; // already fired

    const rawHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      rawHistory.push({ role: "user", content: m.content });
      const prevRaw = rawResponses[m.id];
      // Include this user's raw reply only if we already have a completed one
      // (skips the currently-in-flight turn we're about to fire).
      if (typeof prevRaw === "string") {
        rawHistory.push({ role: "assistant", content: prevRaw });
      }
    }
    void fanOutRaw(rawHistory, last.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, compareMode]);

  return (
    <div className="flex flex-col gap-4">
      <div className="starter-grid">
        {STARTERS.map((s, i) => (
          <button
            key={i}
            type="button"
            className="starter-card"
            disabled={isLoading}
            onClick={() => submitMessage(s, { reset: true })}
          >
            {s}
          </button>
        ))}
      </div>

      {/* The conversation card only appears once a query has been run.
          The empty state is just starters + a clean canvas; the input
          stays sticky at the bottom of the viewport. */}
      {messages.length > 0 && (
      <div className="card">
        <div className="flex flex-col gap-3">
          {messages.map((m, idx) => {
            if (m.role === "user") {
              return (
                <div key={m.id} className="bubble bubble-user">
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              );
            }
            const isStreaming = isLoading && idx === messages.length - 1;
            // Find the user message this assistant turn answers — the one
            // immediately above it. If a raw response exists for that user
            // message, render two columns.
            const precedingUser = idx > 0 ? messages[idx - 1] : null;
            const rawForTurn = precedingUser?.role === "user" ? rawResponses[precedingUser.id] : undefined;

            const axiomTurn = (
              <AssistantTurn
                toolInvocations={m.toolInvocations}
                text={m.content}
                indentTools
                isStreaming={isStreaming}
              />
            );

            if (rawForTurn === undefined) return <div key={m.id}>{axiomTurn}</div>;

            return (
              <div key={m.id} className="compare-grid">
                <Column title="OpenAI alone" tone="neutral">
                  {rawForTurn === null ? <RunningPill label="running" /> : <RawBubble text={rawForTurn} />}
                </Column>
                <Column title="OpenAI + Axiom" tone="grounded">
                  {axiomTurn}
                </Column>
              </div>
            );
          })}
          {/* In-flight indicator. Once the assistant message lands in
              `messages`, the per-turn rendering above owns the running
              state — we only show this for the gap before that first
              stream event. In compare mode, mirror the column layout so
              "consulting the rules engine" sits inside the right card the same
              way "running" sits inside the left. */}
          {isLoading
            && !compareMode
            && messages[messages.length - 1]?.role === "user"
            && (
              <RunningPill label="consulting the rules engine" />
            )}
          {isLoading
            && compareMode
            && messages[messages.length - 1]?.role === "user"
            && (() => {
              const lastUserId = messages[messages.length - 1].id;
              const rawForUser = rawResponses[lastUserId];
              return (
                <div className="compare-grid">
                  <Column title="OpenAI alone" tone="neutral">
                    {typeof rawForUser === "string"
                      ? <RawBubble text={rawForUser} />
                      : <RunningPill label="running" />}
                  </Column>
                  <Column title="OpenAI + Axiom" tone="grounded">
                    <RunningPill label="consulting the rules engine" />
                  </Column>
                </div>
              );
            })()}
        </div>
      </div>
      )}

      {error && (
        <div className="card" style={{ background: "#fee2e2", borderColor: "#fca5a5" }}>
          <div className="text-sm" style={{ color: "#991b1b" }}>
            <strong>Chat error:</strong> {error.message}
          </div>
        </div>
      )}

      <div
        style={{
          position: "sticky",
          bottom: 0,
          background: "var(--paper)",
          paddingTop: 12,
          paddingBottom: 8,
          marginTop: messages.length > 0 ? 4 : "auto",
          zIndex: 5,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
      <form onSubmit={handleSubmit} className="input-pill">
        <textarea
          ref={textareaRef}
          name="prompt"
          value={input}
          onChange={(e) => handleInputChange(e as unknown as React.ChangeEvent<HTMLInputElement>)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (input.trim() && !isLoading) {
                (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
              }
            }
          }}
          placeholder={INPUT_PLACEHOLDER}
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

      <label className="compare-toggle">
        <input
          type="checkbox"
          checked={compareMode}
          onChange={(e) => {
            // Toggling the comparison view resets the conversation so the
            // chat history doesn't mix single-column and two-column turns.
            setCompareMode(e.target.checked);
            setMessages([]);
            setRawResponses({});
            setInput("");
          }}
        />
        Compare side-by-side with plain AI (no axiom-rules-engine)
      </label>
      </div>
    </div>
  );
}

function Column({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "neutral" | "grounded";
  children: React.ReactNode;
}) {
  return (
    <div
      className="card"
      style={{
        background: tone === "grounded" ? "#f0fdfa" : "white",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
      {children}
    </div>
  );
}

function RawBubble({ text }: { text: string }) {
  return (
    <div className="bubble bubble-assistant" style={{ maxWidth: "none" }}>
      <MarkdownText source={text} />
    </div>
  );
}
