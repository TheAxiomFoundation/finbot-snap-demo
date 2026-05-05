"use client";
import type { ToolInvocation } from "ai";
import { useState } from "react";

import { AssistantTurn } from "./AssistantTurn";

const SCENARIOS = [
  {
    id: "co-snap-hours-cut",
    label: "Hours cut to 25/wk",
    prompt:
      "I live in Colorado with my partner and two kids. I just got my hours cut to 25 a week at $15.50/hr. We pay $1,000/mo rent and have heat included. About $200 in savings. Are we eligible for SNAP and how much?",
  },
  {
    id: "co-snap-elderly",
    label: "Elderly retiree",
    prompt:
      "I'm 68, single, get $900/mo from Social Security and $0 wages. $300 in checking. I pay $700 rent and pay my own electric and heat. Anything I'd qualify for?",
  },
  {
    id: "co-snap-not-encoded",
    label: "Out-of-scope (NY SNAP)",
    prompt:
      "I live in New York City, 30 years old, work full-time at $20/hr, single. Do I qualify for SNAP and how much would I get?",
  },
];

export function Compare() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [prompt, setPrompt] = useState(SCENARIOS[0].prompt);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    raw?: { text?: string; error?: string };
    axiom?: { text?: string; invocations?: WireInvocation[]; error?: string };
  } | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      setResult(await r.json());
    } catch (e: any) {
      setResult({ raw: { error: String(e) }, axiom: { error: String(e) } });
    }
    setLoading(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 flex-wrap">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="btn btn-ghost"
            style={{ background: scenarioId === s.id ? "#0b1220" : "white", color: scenarioId === s.id ? "white" : "#0b1220", fontSize: 12 }}
            onClick={() => {
              setScenarioId(s.id);
              setPrompt(s.prompt);
              setResult(null);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="card mono"
        style={{ fontSize: 13, resize: "vertical", outline: 0, lineHeight: 1.5 }}
      />

      <div>
        <button type="button" className="btn" onClick={run} disabled={loading || !prompt.trim()}>
          {loading ? "running both…" : "Run side-by-side"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Pane title="OpenAI alone" subtitle="GPT-4o, no tools, no axiom" tone="neutral" body={result?.raw} loading={loading} />
        <Pane
          title="OpenAI + Axiom"
          subtitle="Same model, axiom-rules tools wired in"
          tone="grounded"
          body={result?.axiom}
          loading={loading}
        />
      </div>
    </div>
  );
}

/** Compact wire shape from /api/compare; mapped onto AI SDK's ToolInvocation
 *  for rendering so the Side-by-side and FinBot tabs share one card surface. */
type WireInvocation = {
  tool_call_id: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

function toAiSdkInvocation(w: WireInvocation): ToolInvocation {
  return {
    state: "result",
    toolCallId: w.tool_call_id,
    toolName: w.name,
    args: w.args,
    result: w.result,
  };
}

function Pane({
  title,
  subtitle,
  tone,
  body,
  loading,
}: {
  title: string;
  subtitle: string;
  tone: "neutral" | "grounded";
  body?: { text?: string; invocations?: WireInvocation[]; error?: string };
  loading: boolean;
}) {
  return (
    <div className="card" style={{ background: tone === "grounded" ? "#f0fdfa" : "white", display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 12, color: "#6b7280" }}>{subtitle}</div>
      </div>
      {loading && <div className="text-xs" style={{ color: "#6b7280" }}>running…</div>}
      {!loading && !body && <div className="text-xs" style={{ color: "#6b7280" }}>—</div>}
      {body?.error && <div style={{ color: "#991b1b", fontSize: 13 }}>error: {body.error}</div>}

      {/* Same component the FinBot chat uses for an assistant turn — tool
          cards (when present) above the markdown bubble. The raw side
          simply has no invocations to render. */}
      {body && (body.text || body.invocations?.length) && (
        <AssistantTurn
          toolInvocations={body.invocations?.map(toAiSdkInvocation)}
          text={body.text}
          fluid
        />
      )}
    </div>
  );
}
