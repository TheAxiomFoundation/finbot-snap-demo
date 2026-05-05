"use client";
import type { ToolInvocation } from "ai";

interface Props {
  invocation: ToolInvocation;
}

export function ToolCallCard({ invocation }: Props) {
  const status = invocation.state;
  const result = "result" in invocation ? invocation.result : undefined;

  return (
    <div className="card" style={{ padding: 12, background: "#fafaf6" }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 11, color: "#6b7280" }}>tool</span>
        <span className="badge badge-source">{invocation.toolName}</span>
        <span className="mono" style={{ fontSize: 11, marginLeft: "auto", color: status === "result" ? "#065f46" : "#92400e" }}>
          {status}
        </span>
      </div>
      {invocation.args && Object.keys(invocation.args).length > 0 && (
        <details style={{ marginBottom: 6 }}>
          <summary className="text-xs" style={{ cursor: "pointer", color: "#6b7280" }}>arguments</summary>
          <pre className="mono" style={{ fontSize: 11, marginTop: 6, whiteSpace: "pre-wrap" }}>{JSON.stringify(invocation.args, null, 2)}</pre>
        </details>
      )}
      {invocation.toolName === "compute_co_snap" && status === "result" && result && (
        <CoSnapResultSummary result={result} />
      )}
      {invocation.toolName === "rank_next_question" && status === "result" && result && (
        <RankedSummary result={result} />
      )}
      {invocation.toolName === "list_encoded_outputs" && status === "result" && result && (
        <CatalogSummary result={result} />
      )}
      {invocation.toolName === "lookup_value" && status === "result" && result && (
        <LookupSummary result={result} />
      )}
      {invocation.toolName === "fetch_citation" && status === "result" && result && (
        <CitationSummary result={result} />
      )}
    </div>
  );
}

function fmt(n: number) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function judgmentBadge(v: "holds" | "not_holds" | undefined) {
  if (v === "holds") return <span className="badge badge-exact">eligible</span>;
  if (v === "not_holds") return <span className="badge badge-blocked">not eligible</span>;
  return <span className="badge badge-range">unknown</span>;
}

function CoSnapResultSummary({ result }: { result: any }) {
  const o = result.outputs ?? {};
  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginBottom: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{fmt(o.snap_regular_month_allotment)}</span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>regular monthly allotment</span>
        {judgmentBadge(o.snap_eligible)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6, fontSize: 12 }}>
        <Row label="Gross income" value={fmt(o.gross_income)} />
        <Row label="Net income" value={fmt(o.snap_net_income)} />
        <Row label="Max allotment (size)" value={fmt(o.snap_maximum_allotment)} />
        <Row label="Standard utility allow." value={fmt(o.snap_standard_utility_allowance)} />
        <Row label="Std deduction" value={fmt(o.snap_standard_deduction)} />
        <Row label="Earned income deduction" value={fmt(o.snap_earned_income_deduction)} />
        <Row label="Excess shelter deduction" value={fmt(o.excess_shelter_deduction)} />
        <Row label="Shelter costs" value={fmt(o.shelter_costs)} />
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
        Sources:{" "}
        {result.citations?.slice(0, 4).map((c: any, i: number) => (
          <span key={c.id}>
            {i > 0 ? ", " : ""}
            <a className="cite" href={c.url} target="_blank" rel="noreferrer">{c.id}</a>
          </span>
        ))}
      </div>
    </div>
  );
}

function RankedSummary({ result }: { result: any }) {
  const ranked = result.ranked ?? [];
  return (
    <div>
      <div className="text-xs" style={{ color: "#6b7280", marginBottom: 6 }}>
        Ranked by how much each unknown moves the SNAP allotment.
      </div>
      <div className="flex flex-col gap-2">
        {ranked.slice(0, 4).map((r: any, i: number) => (
          <div key={r.fact_key} style={{ borderTop: i ? "1px dashed #e6e6df" : 0, paddingTop: i ? 6 : 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, minWidth: 32 }}>{fmt(r.variance_dollars)}</span>
              <span style={{ fontSize: 13 }}>{r.question}</span>
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginLeft: 40 }}>{r.why}</div>
          </div>
        ))}
        {ranked.length === 0 && <div className="text-xs" style={{ color: "#6b7280" }}>No remaining unknowns to rank.</div>}
      </div>
    </div>
  );
}

function CatalogSummary({ result }: { result: any }) {
  const programs = result.programs ?? [];
  return (
    <div>
      <div className="text-xs" style={{ color: "#6b7280", marginBottom: 6 }}>
        {programs.length} encoded program{programs.length === 1 ? "" : "s"}.
      </div>
      <div className="flex flex-col gap-2">
        {programs.map((p: any) => (
          <div key={p.slug} className="mono" style={{ fontSize: 12 }}>
            <strong>{p.display_name}</strong> · {p.outputs.length} outputs · <span style={{ color: "#6b7280" }}>{p.rulespec_path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LookupSummary({ result }: { result: any }) {
  const v = result.value;
  let display: string;
  if (v === null || v === undefined) display = "—";
  else if (v === "holds") display = "✓ holds";
  else if (v === "not_holds") display = "✗ does not hold";
  else display = `${result.unit === "USD" ? "$" : ""}${typeof v === "number" ? Math.round(v).toLocaleString() : v}${result.unit && result.unit !== "USD" ? " " + result.unit : ""}`;
  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{display}</span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>{result.name}</span>
        <span className="badge badge-source" style={{ fontSize: 10 }}>{result.entity}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: "#6b7280" }}>
        <a className="cite" href={`https://app.axiom-foundation.org/${(result.legal_id ?? "").split(":")[0]}/${(result.legal_id ?? "").split(":")[1]?.replace("statutes", "statute").replace("regulations", "regulation").replace("policies", "policy").split("#")[0]}`} target="_blank" rel="noreferrer">
          {result.legal_id}
        </a>
      </div>
      {result.source && (
        <div style={{ fontSize: 11, color: "#374151", marginTop: 4 }}>{result.source}</div>
      )}
    </div>
  );
}

function CitationSummary({ result }: { result: any }) {
  return (
    <div style={{ fontSize: 12 }}>
      <a className="cite" href={result.url} target="_blank" rel="noreferrer">{result.legal_id}</a>
      {result.heading && <div style={{ fontWeight: 600, marginTop: 4 }}>{result.heading}</div>}
      {result.body_excerpt && (
        <div style={{ color: "#374151", marginTop: 4, lineHeight: 1.5 }}>{result.body_excerpt}</div>
      )}
      {!result.body_excerpt && (
        <div className="text-xs" style={{ color: "#6b7280", marginTop: 4 }}>
          {result.resolution === "not_found"
            ? "axiom-corpus has no document at this path yet. The legal source URL above still works."
            : "axiom-corpus returned this document but no body text. Click through to view the source."}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
