"use client";
import { useState } from "react";

import type { CoSnapFacts } from "@/lib/programs/co-snap";

/**
 * Walkthrough tab — a live tour of the four tools the chat actually calls.
 * Every "Run" button hits /api/tool, which dispatches to the same underlying
 * functions registered as AI SDK tools in lib/tools.ts. No pre-canned
 * scenarios, no mock data.
 */
export function Walkthrough() {
  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, color: "#6b7280", letterSpacing: 0.05 }}>
          TOUR · LIVE TOOLS
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>What the chat actually calls</h2>
        <p style={{ fontSize: 13.5, color: "#374151", marginTop: 6, lineHeight: 1.5 }}>
          The five sections below are the same tools registered for the LLM in <span className="mono">src/lib/tools.ts</span>. Each Run hits <span className="mono">/api/tool</span>, which dispatches to the underlying engine functions — the chat uses the exact same code path. Edit the inputs, click Run, see the real response.
        </p>
      </div>

      <ListEncodedOutputsSection />
      <ComputeCoSnapSection />
      <LookupValueSection />
      <RankNextQuestionSection />
      <FetchCitationSection />
    </div>
  );
}

// ─── shared bits ────────────────────────────────────────────────────────────

async function callTool<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  const json = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${r.status}`);
  return json;
}

function ToolHeader({ name, blurb }: { name: string; blurb: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontSize: 11, background: "#0b1220", color: "white", padding: "3px 8px", borderRadius: 6, fontWeight: 700 }}>
          TOOL
        </span>
        <span className="mono" style={{ fontSize: 14, fontWeight: 700 }}>{name}</span>
      </div>
      <p style={{ fontSize: 13, color: "#374151", marginTop: 6, lineHeight: 1.5 }}>{blurb}</p>
    </div>
  );
}

function RunButton({ onClick, pending, label = "Run" }: { onClick: () => void; pending: boolean; label?: string }) {
  return (
    <button type="button" className="btn" onClick={onClick} disabled={pending} style={{ alignSelf: "flex-start" }}>
      {pending ? "running…" : label}
    </button>
  );
}

function ErrorRow({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="card" style={{ background: "#fee2e2", borderColor: "#fca5a5", padding: 10, marginTop: 10 }}>
      <div className="mono" style={{ fontSize: 12, color: "#991b1b" }}>{error}</div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "200px 1fr", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 12, color: "#374151" }}>{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | "";
  onChange: (v: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? undefined : Number(v));
      }}
      placeholder={placeholder ?? "—"}
      style={{
        padding: "6px 10px",
        border: "1px solid #e6e6df",
        borderRadius: 8,
        fontSize: 13,
        fontFamily: "JetBrains Mono, monospace",
      }}
    />
  );
}

function BoolInput({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <select
      value={value === undefined ? "" : value ? "true" : "false"}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? undefined : v === "true");
      }}
      style={{ padding: "6px 10px", border: "1px solid #e6e6df", borderRadius: 8, fontSize: 13 }}
    >
      <option value="">— (leave undefined)</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        padding: "6px 10px",
        border: "1px solid #e6e6df",
        borderRadius: 8,
        fontSize: 13,
        fontFamily: "JetBrains Mono, monospace",
      }}
    />
  );
}

function ResultBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="mono" style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>RESPONSE</div>
      {children}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre
      className="mono"
      style={{
        background: "#0b1220",
        color: "#f8fafc",
        padding: 12,
        borderRadius: 10,
        fontSize: 11.5,
        overflow: "auto",
        maxHeight: 320,
        margin: 0,
        lineHeight: 1.45,
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function fmt(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

// ─── 1. list_encoded_outputs ────────────────────────────────────────────────

function ListEncodedOutputsSection() {
  const [search, setSearch] = useState("");
  const [jurisdiction, setJurisdiction] = useState<"" | "us-co" | "us">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type Result = {
    programs: Array<{ display_name: string; rulespec_path: string }>;
    encoded_outputs_total: number;
    search_matches?: Array<{ legal_id: string; name: string; entity: string; semantics: string; unit: string | null }>;
    search_matches_total?: number;
    truncated?: boolean;
  };
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setPending(true); setError(null);
    try {
      const args: Record<string, string> = {};
      if (search.trim()) args.search = search.trim();
      if (jurisdiction) args.jurisdiction = jurisdiction;
      setResult(await callTool<Result>("list_encoded_outputs", args));
    } catch (e) { setError(String(e)); }
    setPending(false);
  }

  return (
    <section className="card" style={{ padding: 18 }}>
      <ToolHeader
        name="list_encoded_outputs"
        blurb="Discovery. Returns the encoded programs, plus an optional name search across all 168 derived outputs in CO SNAP. The model calls this first to confirm a program is encoded and to find the legal_id of a specific value."
      />
      <div className="flex flex-col gap-2" style={{ maxWidth: 600 }}>
        <FieldRow label="search">
          <TextInput value={search} onChange={setSearch} placeholder="e.g. income limit, utility allowance, deduction" />
        </FieldRow>
        <FieldRow label="jurisdiction">
          <select
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value as "" | "us-co" | "us")}
            style={{ padding: "6px 10px", border: "1px solid #e6e6df", borderRadius: 8, fontSize: 13 }}
          >
            <option value="">— (any)</option>
            <option value="us-co">us-co</option>
            <option value="us">us</option>
          </select>
        </FieldRow>
        <RunButton onClick={run} pending={pending} />
      </div>
      <ErrorRow error={error} />
      {result && (
        <ResultBox>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <strong>{result.programs.length}</strong> program(s) ·{" "}
            <strong>{result.encoded_outputs_total}</strong> encoded outputs total
            {typeof result.search_matches_total === "number" && (
              <> · <strong>{result.search_matches_total}</strong> matching search</>
            )}
          </div>
          {result.search_matches && result.search_matches.length > 0 ? (
            <div className="flex flex-col gap-1">
              {result.search_matches.slice(0, 12).map((m) => (
                <div key={m.legal_id} className="mono" style={{ fontSize: 11.5, padding: "6px 8px", background: "#fafaf6", borderRadius: 6 }}>
                  <span style={{ color: "#075985" }}>{m.legal_id}</span>
                  <span style={{ color: "#6b7280" }}> · {m.entity} · {m.semantics}{m.unit ? ` · ${m.unit}` : ""}</span>
                </div>
              ))}
              {result.truncated && (
                <div className="text-xs" style={{ color: "#6b7280", marginTop: 4 }}>… truncated; refine the search to see more</div>
              )}
            </div>
          ) : result.search_matches ? (
            <div className="text-sm" style={{ color: "#6b7280" }}>No matches.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {result.programs.map((p) => (
                <div key={p.rulespec_path} className="mono" style={{ fontSize: 12 }}>
                  <strong>{p.display_name}</strong> <span style={{ color: "#6b7280" }}>· {p.rulespec_path}</span>
                </div>
              ))}
            </div>
          )}
        </ResultBox>
      )}
    </section>
  );
}

// ─── shared facts form ──────────────────────────────────────────────────────

const FACT_FIELDS: Array<{
  key: keyof CoSnapFacts;
  label: string;
  type: "number" | "bool";
}> = [
  { key: "household_size", label: "household_size", type: "number" },
  { key: "monthly_earnings_per_adult", label: "monthly_earnings_per_adult", type: "number" },
  { key: "monthly_unearned_income", label: "monthly_unearned_income", type: "number" },
  { key: "monthly_shelter_costs", label: "monthly_shelter_costs", type: "number" },
  { key: "pays_separate_heating_or_cooling", label: "pays_separate_heating_or_cooling", type: "bool" },
  { key: "liquid_resources", label: "liquid_resources", type: "number" },
  { key: "oldest_member_age", label: "oldest_member_age", type: "number" },
  { key: "any_member_elderly_or_disabled", label: "any_member_elderly_or_disabled", type: "bool" },
  { key: "primary_member_is_us_citizen", label: "primary_member_is_us_citizen", type: "bool" },
];

function FactsForm({ facts, setFacts }: { facts: CoSnapFacts; setFacts: (f: CoSnapFacts) => void }) {
  return (
    <div className="flex flex-col gap-2" style={{ maxWidth: 700 }}>
      {FACT_FIELDS.map((f) => (
        <FieldRow key={f.key as string} label={f.label}>
          {f.type === "number" ? (
            <NumberInput
              value={facts[f.key] === undefined ? "" : (facts[f.key] as number)}
              onChange={(v) => setFacts({ ...facts, [f.key]: v })}
            />
          ) : (
            <BoolInput
              value={facts[f.key] as boolean | undefined}
              onChange={(v) => setFacts({ ...facts, [f.key]: v })}
            />
          )}
        </FieldRow>
      ))}
    </div>
  );
}

// ─── 2. compute_co_snap ─────────────────────────────────────────────────────

function ComputeCoSnapSection() {
  const [facts, setFacts] = useState<CoSnapFacts>({
    household_size: 3,
    monthly_earnings_per_adult: 1550,
    monthly_shelter_costs: 500,
    oldest_member_age: 30,
    primary_member_is_us_citizen: true,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outputs?: Record<string, number | string>; citations?: Array<{ id: string; url: string }> } | null>(null);

  async function run() {
    setPending(true); setError(null);
    try { setResult(await callTool("compute_co_snap", { facts })); }
    catch (e) { setError(String(e)); }
    setPending(false);
  }

  return (
    <section className="card" style={{ padding: 18 }}>
      <ToolHeader
        name="compute_co_snap"
        blurb="Whole-household calculation. Runs the FY-2026 CO SNAP rulespec against the supplied facts and returns 15 surface outputs (allotment, eligibility judgments, deductions). This is the tool the chat calls when the user asks 'what would I get?'"
      />
      <FactsForm facts={facts} setFacts={setFacts} />
      <div style={{ marginTop: 12 }}>
        <RunButton onClick={run} pending={pending} />
      </div>
      <ErrorRow error={error} />
      {result?.outputs && (
        <ResultBox>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <KV label="snap_regular_month_allotment" value={fmt(result.outputs.snap_regular_month_allotment)} highlight />
            <KV label="snap_eligible" value={String(result.outputs.snap_eligible)} judgment={result.outputs.snap_eligible} />
            <KV label="snap_resource_eligible" value={String(result.outputs.snap_resource_eligible)} judgment={result.outputs.snap_resource_eligible} />
            <KV label="snap_income_eligible" value={String(result.outputs.snap_income_eligible)} judgment={result.outputs.snap_income_eligible} />
            <KV label="gross_income" value={fmt(result.outputs.gross_income)} />
            <KV label="snap_net_income" value={fmt(result.outputs.snap_net_income)} />
            <KV label="snap_maximum_allotment" value={fmt(result.outputs.snap_maximum_allotment)} />
            <KV label="snap_standard_utility_allowance" value={fmt(result.outputs.snap_standard_utility_allowance)} />
            <KV label="excess_shelter_deduction" value={fmt(result.outputs.excess_shelter_deduction)} />
          </div>
          <details style={{ marginTop: 10 }}>
            <summary className="mono" style={{ fontSize: 11, color: "#6b7280", cursor: "pointer" }}>raw response JSON</summary>
            <div style={{ marginTop: 8 }}>
              <JsonBlock value={result} />
            </div>
          </details>
        </ResultBox>
      )}
    </section>
  );
}

// ─── 3. lookup_value ────────────────────────────────────────────────────────

function LookupValueSection() {
  const [legalId, setLegalId] = useState(
    "us:policies/usda/snap/fy-2026-cola/income-eligibility-standards#snap_gross_income_limit_130_percent_fpl_48_states_dc"
  );
  const [facts, setFacts] = useState<CoSnapFacts>({ household_size: 4 });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    name?: string; entity?: string; value?: number | string | null; unit?: string | null; source?: string | null;
  } | null>(null);

  async function run() {
    setPending(true); setError(null);
    try { setResult(await callTool("lookup_value", { legal_id: legalId, facts })); }
    catch (e) { setError(String(e)); }
    setPending(false);
  }

  return (
    <section className="card" style={{ padding: 18 }}>
      <ToolHeader
        name="lookup_value"
        blurb="Read any of the 168 encoded outputs by legal_id. The chat uses this for questions like 'what's the income threshold?' or 'what's the standard deduction?' — values that compute_co_snap doesn't surface but are reachable in the rule graph. Combine with list_encoded_outputs(search) to find the right legal_id."
      />
      <div className="flex flex-col gap-2" style={{ maxWidth: 900 }}>
        <FieldRow label="legal_id">
          <TextInput value={legalId} onChange={setLegalId} />
        </FieldRow>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "#6b7280", margin: "12px 0 4px" }}>FACTS (only the ones that affect this output matter)</div>
      <FactsForm facts={facts} setFacts={setFacts} />
      <div style={{ marginTop: 12 }}>
        <RunButton onClick={run} pending={pending} />
      </div>
      <ErrorRow error={error} />
      {result && (
        <ResultBox>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>
              {result.value === "holds" ? "✓ holds" :
                result.value === "not_holds" ? "✗ does not hold" :
                  typeof result.value === "number" ? `${result.unit === "USD" ? "$" : ""}${Math.round(result.value).toLocaleString()}${result.unit && result.unit !== "USD" ? " " + result.unit : ""}` :
                    "—"}
            </span>
            <span style={{ fontSize: 12, color: "#6b7280" }}>{result.name}</span>
            <span className="badge badge-source" style={{ fontSize: 10 }}>{result.entity}</span>
          </div>
          {result.source && <div style={{ fontSize: 12, color: "#374151", marginTop: 6 }}>{result.source}</div>}
        </ResultBox>
      )}
    </section>
  );
}

// ─── 4. rank_next_question ──────────────────────────────────────────────────

function RankNextQuestionSection() {
  const [facts, setFacts] = useState<CoSnapFacts>({
    household_size: 3,
    monthly_earnings_per_adult: 1550,
    oldest_member_age: 30,
    primary_member_is_us_citizen: true,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    ranked: Array<{ question: string; why: string; fact_key: string; variance_dollars: number; bracket: { values: unknown[]; labels: string[]; allotments: number[] } }>;
  } | null>(null);

  async function run() {
    setPending(true); setError(null);
    try { setResult(await callTool("rank_next_question", { facts })); }
    catch (e) { setError(String(e)); }
    setPending(false);
  }

  return (
    <section className="card" style={{ padding: 18 }}>
      <ToolHeader
        name="rank_next_question"
        blurb="For each candidate unknown, runs compute_co_snap twice with the bracket extremes and measures how many dollars the SNAP allotment moves. Returns the candidates ordered by variance, so the chat can ask the single most-impactful follow-up."
      />
      <FactsForm facts={facts} setFacts={setFacts} />
      <div style={{ marginTop: 12 }}>
        <RunButton onClick={run} pending={pending} />
      </div>
      <ErrorRow error={error} />
      {result && (
        <ResultBox>
          {result.ranked.length === 0 ? (
            <div className="text-sm" style={{ color: "#6b7280" }}>No remaining unknowns.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {result.ranked.map((r, i) => (
                <div key={r.fact_key} className="card" style={{ padding: 10, background: i === 0 ? "#fafaf6" : "white" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="mono" style={{ fontSize: 13, fontWeight: 700, minWidth: 50 }}>
                      ${r.variance_dollars.toLocaleString()}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: i === 0 ? 600 : 400 }}>{r.question}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginLeft: 58, marginTop: 2 }}>{r.why}</div>
                  <div style={{ marginLeft: 58, marginTop: 6, display: "flex", gap: 12, fontSize: 11 }}>
                    <span>{r.bracket.labels[0]}: <strong>${r.bracket.allotments[0].toLocaleString()}</strong></span>
                    <span style={{ color: "#6b7280" }}>↔</span>
                    <span>{r.bracket.labels[1]}: <strong>${r.bracket.allotments[1].toLocaleString()}</strong></span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ResultBox>
      )}
    </section>
  );
}

// ─── 5. fetch_citation ──────────────────────────────────────────────────────

function FetchCitationSection() {
  const [legalId, setLegalId] = useState("us:statutes/7/2017/a");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    legal_id?: string; citation_path?: string; heading?: string | null; body_excerpt?: string | null; url?: string; resolved?: boolean; resolution?: string;
  } | null>(null);

  async function run() {
    setPending(true); setError(null);
    try { setResult(await callTool("fetch_citation", { legal_id: legalId })); }
    catch (e) { setError(String(e)); }
    setPending(false);
  }

  return (
    <section className="card" style={{ padding: 18 }}>
      <ToolHeader
        name="fetch_citation"
        blurb="Pulls legal text from axiom-foundation.org's corpus API. First tries the corpus_citation_path declared in the source rulespec; falls back to a structural rewrite. Returns resolution status so the model knows when no body text is available."
      />
      <div className="flex flex-col gap-2" style={{ maxWidth: 900 }}>
        <FieldRow label="legal_id">
          <TextInput value={legalId} onChange={setLegalId} placeholder="us:statutes/7/2017/a" />
        </FieldRow>
        <RunButton onClick={run} pending={pending} />
      </div>
      <ErrorRow error={error} />
      {result && (
        <ResultBox>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
            <span className={`badge ${result.resolved ? "badge-exact" : "badge-blocked"}`}>
              {result.resolution}
            </span>
            <span className="mono" style={{ fontSize: 11, color: "#6b7280" }}>{result.citation_path}</span>
            {result.url && <a className="cite" href={result.url} target="_blank" rel="noreferrer">view in app ↗</a>}
          </div>
          {result.heading && <div style={{ fontWeight: 600, fontSize: 13 }}>{result.heading}</div>}
          {result.body_excerpt ? (
            <div style={{ fontSize: 13, color: "#374151", marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{result.body_excerpt}</div>
          ) : (
            <div className="text-sm" style={{ color: "#6b7280", marginTop: 6 }}>
              {result.resolution === "not_found"
                ? "axiom-corpus doesn't have a document at this path yet."
                : "no body text in the corpus response."}
            </div>
          )}
        </ResultBox>
      )}
    </section>
  );
}

// ─── KV helper (used by ComputeCoSnapSection) ───────────────────────────────

function KV({ label, value, highlight, judgment }: { label: string; value: string; highlight?: boolean; judgment?: unknown }) {
  return (
    <div
      className="card"
      style={{
        padding: 10,
        background: highlight ? "#0b1220" : "white",
        color: highlight ? "white" : "inherit",
        borderColor: highlight ? "#0b1220" : undefined,
      }}
    >
      <div className="mono" style={{ fontSize: 11, opacity: highlight ? 0.7 : 0.6 }}>{label}</div>
      <div className="mono" style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>
        {judgment === "holds" ? "✓ eligible" : judgment === "not_holds" ? "✗ not eligible" : value}
      </div>
    </div>
  );
}
