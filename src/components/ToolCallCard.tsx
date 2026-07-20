"use client";
import type { ToolInvocation } from "ai";

import { legalIdToUrl } from "@/lib/legal-links";
import { formatValue } from "@/lib/money";

interface Props {
  invocation: ToolInvocation;
}

/** One-line summary of what distinguishes this call from siblings of the
 *  same tool — program, output, search term, member count. Facts get their
 *  own chip row inside the card body. */
function argSummary(inv: ToolInvocation): string | null {
  const args = (inv.args ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof args.program === "string") parts.push(args.program);
  if (typeof args.output === "string") parts.push(args.output);
  if (typeof args.legal_id === "string") parts.push(args.legal_id);
  if (typeof args.search === "string" && args.search) parts.push(`“${args.search}”`);
  if (typeof args.inputs_search === "string" && args.inputs_search) parts.push(`inputs “${args.inputs_search}”`);
  if (Array.isArray(args.members) && args.members.length)
    parts.push(`${args.members.length} member${args.members.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : null;
}

export function ToolCallCard({ invocation }: Props) {
  const status = invocation.state;
  const result = "result" in invocation ? invocation.result : undefined;
  const hasError = status === "result" && result && typeof result === "object" && "error" in result;
  const summary = argSummary(invocation);

  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <span className="badge badge-source">{invocation.toolName}</span>
        {summary && <span className="mono tool-card-summary">{summary}</span>}
        {status === "result" && typeof (result as any)?._ms === "number" && (
          <span className="mono tool-card-summary" style={{ marginLeft: "auto" }}>
            {(result as any)._ms}ms
          </span>
        )}
        <span
          className={`tool-status-dot ${status === "result" ? "done" : "running"}`}
          title={status === "result" ? "completed" : "running"}
          style={status === "result" && typeof (result as any)?._ms === "number" ? { marginLeft: 0 } : undefined}
        />
      </div>

      {hasError && <ErrorSummary result={result} />}
      {!hasError && status === "result" && result != null && (
        <>
          {invocation.toolName === "compute" && <ComputeCard result={result} />}
          {invocation.toolName === "list_programs" && <ProgramListCard result={result} />}
          {invocation.toolName === "describe_program" && <DescribeCard result={result} />}
          {invocation.toolName === "lookup_value" && <LookupCard result={result} />}
          {invocation.toolName === "fetch_citation" && <CitationCard result={result} />}
        </>
      )}

      {invocation.args && Object.keys(invocation.args).length > 0 && (
        <details className="tool-details" style={{ marginTop: 7 }}>
          <summary>raw arguments</summary>
          <pre className="mono">{JSON.stringify(invocation.args, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function ErrorSummary({ result }: { result: any }) {
  return (
    <div className="tool-note">
      {result.error}
      {Array.isArray(result.suggestions) && result.suggestions.length > 0 && (
        <div className="mono" style={{ marginTop: 3, color: "#6b7280" }}>
          try: {result.suggestions.slice(0, 4).join(", ")}
        </div>
      )}
    </div>
  );
}

function judgmentBadge(v: unknown) {
  if (v === "holds") return <span className="badge badge-exact">holds</span>;
  if (v === "not_holds") return <span className="badge badge-blocked">does not hold</span>;
  return <span className="badge badge-range">unknown</span>;
}

function IncompleteBadge() {
  return (
    <span
      className="badge badge-incomplete"
      title="The rulespec authors flag this output as not fully encoded yet."
    >
      incomplete
    </span>
  );
}

function displayValue(o: { value: unknown; unit?: string | null }): string {
  if (typeof o.value === "number") return formatValue(o.value, o.unit);
  if (o.value === "holds") return "✓ holds";
  if (o.value === "not_holds") return "✗ does not hold";
  if (o.value === null || o.value === undefined) return "—";
  return String(o.value);
}

function Citations({ citations }: { citations?: Array<{ id: string; url: string }> }) {
  if (!citations?.length) return null;
  const shown = citations.slice(0, 3);
  return (
    <>
      {" · "}
      {shown.map((c, i) => (
        <span key={c.id}>
          {i > 0 ? ", " : ""}
          <a className="cite" style={{ fontSize: 11 }} href={c.url} target="_blank" rel="noreferrer">
            {c.id}
          </a>
        </span>
      ))}
      {citations.length > shown.length && ` +${citations.length - shown.length} sources`}
    </>
  );
}

function FactChips({ facts }: { facts?: Record<string, unknown> }) {
  const entries = Object.entries(facts ?? {});
  if (!entries.length) return null;
  return (
    <div className="tool-facts">
      {entries.map(([k, v]) => (
        <span key={k} className="tool-fact-chip">
          {k}={String(v)}
        </span>
      ))}
    </div>
  );
}

function ComputeCard({ result }: { result: any }) {
  const outputs: any[] = result.outputs ?? [];
  const primary = outputs.find((o: any) => o.name === result.primary_output) ?? outputs[0];
  const rest = outputs.filter((o: any) => o !== primary && o.value !== null);
  const applied = result.applied ?? {};

  return (
    <div>
      <div className="tool-headline">
        <span className="value">{primary ? displayValue(primary) : "—"}</span>
        <span className="caption">
          {primary?.label} · {result.display_name} · {result.period}
        </span>
        {primary?.semantics === "judgment" && judgmentBadge(primary.value)}
        {primary?.acknowledged_incomplete && <IncompleteBadge />}
      </div>

      {rest.length > 0 && (
        <div className="tool-rows">
          {rest.map((o: any) => (
            <div key={o.name} className="tool-row">
              <span className="k">
                {o.label}
                {o.acknowledged_incomplete && <> <IncompleteBadge /></>}
              </span>
              <span className="v" style={o.semantics === "judgment" ? { color: o.value === "holds" ? "#065f46" : "#991b1b" } : undefined}>
                {displayValue(o)}
              </span>
            </div>
          ))}
        </div>
      )}

      {result.member_checks?.length > 0 && (
        <div className="tool-rows">
          {result.member_checks.map((o: any) => (
            <div key={o.name} style={{ padding: "4px 0", borderBottom: "1px dashed #eeeee8" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                <span className="k" style={{ color: "#374151" }}>member check · {o.label}</span>
                <span className="v mono" style={{ color: o.value === "holds" ? "#065f46" : "#991b1b" }}>
                  {displayValue(o)}
                </span>
              </div>
              {o.value === "not_holds" && o.requires && (
                <div className="mono" style={{ fontSize: 10.5, color: "#92400e", marginTop: 2 }}>
                  requires: {o.requires.map((r: any) => `${r.slot}=${r.value}`).join(" ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {result.incomplete_note && <div className="tool-note">{result.incomplete_note}</div>}
      <FactChips facts={applied.facts_applied} />
      <div className="tool-foot">
        {result.member_count > 0 && <>{result.member_count} member{result.member_count === 1 ? "" : "s"} · </>}
        {applied.defaulted_slots ?? 0} slots defaulted
        <Citations citations={result.citations} />
      </div>
    </div>
  );
}

function ProgramListCard({ result }: { result: any }) {
  const programs: any[] = result.programs ?? [];
  const matches: any[] = result.search_matches ?? [];
  const jurisdictions = new Set(programs.map((p: any) => p.jurisdiction)).size;
  return (
    <div>
      <div className="tool-headline">
        <span className="value">{programs.length}</span>
        <span className="caption">
          certified program{programs.length === 1 ? "" : "s"} · {jurisdictions} jurisdiction{jurisdictions === 1 ? "" : "s"} · {result.release}
        </span>
      </div>
      {matches.length > 0 && (
        <div className="tool-rows">
          {matches.slice(0, 8).map((m: any) => (
            <div key={`${m.program}:${m.name}`} className="tool-row">
              <span className="k mono">{m.name}</span>
              <span className="v" style={{ color: "#6b7280" }}>{m.program}</span>
            </div>
          ))}
          {matches.length > 8 && (
            <div className="tool-foot">+{matches.length - 8} more matches</div>
          )}
        </div>
      )}
      <details className="tool-details" style={{ marginTop: 7 }}>
        <summary>all programs</summary>
        <div style={{ marginTop: 6 }}>
          {programs.map((p: any) => (
            <div key={p.slug} className="tool-row">
              <span className="k">{p.display_name}</span>
              <span className="v" style={{ color: "#6b7280" }}>{p.slug}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function DescribeCard({ result }: { result: any }) {
  const inputs = result.inputs ?? {};
  const slotTotal = Object.values(inputs).reduce(
    (n: number, g: any) => n + (g.slots?.length ?? 0) + (g.omitted ?? 0),
    0
  );
  return (
    <div>
      <div className="tool-headline">
        <span className="caption" style={{ fontSize: 13, color: "var(--ink)" }}>
          <strong>{result.display_name}</strong>
        </span>
        <span className="caption">
          {result.primary_entity}
          {result.member_entity ? ` + ${result.member_entity} members` : ""} · {slotTotal} input slots · {result.total_outputs} outputs
        </span>
        {result.acknowledged_incomplete?.length > 0 && <IncompleteBadge />}
      </div>
      <div className="tool-rows">
        <div className="tool-row">
          <span className="k">primary output</span>
          <span className="v">{result.primary_output}</span>
        </div>
        {result.certified_outputs?.filter((n: string) => n !== result.primary_output).map((name: string) => (
          <div key={name} className="tool-row">
            <span className="k">certified</span>
            <span className="v">{name}</span>
          </div>
        ))}
      </div>
      {Object.entries(inputs).map(([entity, group]: [string, any]) => (
        <details key={entity} className="tool-details" style={{ marginTop: 6 }}>
          <summary>
            {entity} inputs ({group.slots.length}
            {group.omitted > 0 ? ` shown, ${group.omitted} more` : ""})
          </summary>
          <div className="tool-facts" style={{ marginTop: 6 }}>
            {group.slots.map((s: string) => (
              <span key={s} className="tool-fact-chip">{s}</span>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function LookupCard({ result }: { result: any }) {
  return (
    <div>
      <div className="tool-headline">
        <span className="value">{displayValue(result)}</span>
        <span className="caption">{result.label ?? result.name} · {result.program}</span>
        <span className="badge badge-source" style={{ fontSize: 10 }}>{result.entity}</span>
        {result.acknowledged_incomplete && <IncompleteBadge />}
      </div>
      {result.incomplete_note && <div className="tool-note">{result.incomplete_note}</div>}
      <FactChips facts={result.applied?.facts_applied} />
      <div className="tool-foot">
        {result.source && <>{result.source}</>}
        {result.legal_id && (
          <>
            {result.source ? " · " : ""}
            <a className="cite" style={{ fontSize: 11 }} href={result.url ?? legalIdToUrl(result.legal_id)} target="_blank" rel="noreferrer">
              {result.legal_id}
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function CitationCard({ result }: { result: any }) {
  return (
    <div style={{ marginTop: 6 }}>
      <a className="cite" href={result.url} target="_blank" rel="noreferrer">{result.legal_id}</a>
      {result.heading && <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>{result.heading}</div>}
      {result.body_excerpt ? (
        <div style={{ color: "#374151", fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{result.body_excerpt}</div>
      ) : (
        <div className="tool-foot">
          {result.resolution === "not_found"
            ? "axiom-corpus has no document at this path yet. The legal source URL above still works."
            : "axiom-corpus returned this document but no body text. Click through to view the source."}
        </div>
      )}
    </div>
  );
}
