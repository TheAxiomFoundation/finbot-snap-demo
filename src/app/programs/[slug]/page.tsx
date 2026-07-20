import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getCatalog, getProgram } from "@/lib/catalog";
import { legalIdToUrl } from "@/lib/legal-links";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getCatalog().programs.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const program = getProgram(slug);
  return {
    title: program ? `${program.display_name} — Axiom rules engine` : "Program not found",
    description: program?.description,
  };
}

export default async function ProgramPage({ params }: PageProps) {
  const { slug } = await params;
  const program = getProgram(slug);
  if (!program) notFound();
  const catalog = getCatalog();

  const certifiedSet = new Set(program.certified_outputs);
  const incompleteSet = new Set(program.acknowledged_incomplete);
  const certifiedOutputs = program.outputs.filter((o) => certifiedSet.has(o.name));
  const otherOutputCount = program.outputs.length - certifiedOutputs.length;

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "40px 20px 80px" }}>
      <div style={{ marginBottom: 8 }}>
        <Link href="/programs" className="mono" style={{ fontSize: 13, textDecoration: "underline", textUnderlineOffset: 3 }}>
          ← all programs
        </Link>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>{program.display_name}</h1>
      <p style={{ color: "#374151", margin: "6px 0 4px" }}>{program.description}</p>
      <p className="mono" style={{ fontSize: 12, color: "#6b7280", marginBottom: 20 }}>
        {program.slug} · period {program.evaluation_period} · {program.counts.derived} rules ·{" "}
        {program.counts.parameters} parameters ·{" "}
        <a
          className="cite"
          href={`https://github.com/${catalog.repo}/blob/${catalog.corpus_sha}/${program.spec_path}`}
          target="_blank"
          rel="noreferrer"
        >
          spec @ {catalog.corpus_sha.slice(0, 12)}
        </a>
      </p>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Entities</h2>
        <div className="mono" style={{ fontSize: 13 }}>
          primary: <strong>{program.primary_entity}</strong>
          {program.member_entity && (
            <>
              {" · "}members: <strong>{program.member_entity}</strong>
            </>
          )}
          {program.relations.filter((r) => r.used).length > 0 && (
            <>
              {" · "}relations:{" "}
              {program.relations
                .filter((r) => r.used)
                .map((r) => r.name.split("#").pop()!.replace(/^relation\./, "") + (r.related_entity ? `→${r.related_entity}` : ""))
                .join(", ")}
            </>
          )}
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
          Certified outputs
          {otherOutputCount > 0 && (
            <span style={{ fontSize: 12, fontWeight: 400, color: "#6b7280" }}>
              {" "}
              (+{otherOutputCount} more encoded rules readable via lookup_value)
            </span>
          )}
        </h2>
        <div style={{ display: "grid", gap: 8 }}>
          {certifiedOutputs.map((output) => (
            <div key={output.name} className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{output.name}</span>
                <span className="badge badge-source" style={{ fontSize: 10 }}>{output.entity}</span>
                <span className="mono" style={{ fontSize: 11, color: "#6b7280" }}>
                  {output.semantics}
                  {output.unit ? ` · ${output.unit}` : ""}
                  {output.period ? ` · ${output.period}` : ""}
                </span>
                {output.name === program.primary_output && (
                  <span className="badge badge-exact" style={{ fontSize: 10 }}>primary</span>
                )}
                {incompleteSet.has(output.name) && (
                  <span
                    className="badge"
                    style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}
                  >
                    acknowledged incomplete
                  </span>
                )}
              </div>
              {output.id && (
                <div style={{ marginTop: 4 }}>
                  <a className="cite" style={{ fontSize: 11 }} href={legalIdToUrl(output.id)} target="_blank" rel="noreferrer">
                    {output.id}
                  </a>
                </div>
              )}
              {output.source && (
                <div style={{ fontSize: 11, color: "#374151", marginTop: 2 }}>{output.source}</div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Input slots</h2>
        {Object.entries(program.inputs).map(([entity, slots]) => (
          <details key={entity} style={{ marginBottom: 10 }} open={slots.length <= 40}>
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
              {entity} ({slots.length})
            </summary>
            <div
              className="mono"
              style={{
                fontSize: 11,
                lineHeight: 1.8,
                marginTop: 6,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: "0 16px",
              }}
            >
              {slots.map((slot) => (
                <div key={slot.name}>
                  {slot.name}
                  <span style={{ color: "#6b7280" }}>
                    : {slot.dtype} = {JSON.stringify(slot.default)}
                    {slot.default_source ? ` (${slot.default_source})` : ""}
                    {slot.enum
                      ? ` {${Object.entries(slot.enum)
                          .map(([v, label]) => `${v}${label ? `=${label}` : ""}`)
                          .join(", ")}}`
                      : ""}
                    {slot.eq_hints?.length ? ` (eq ${slot.eq_hints.join("|")})` : ""}
                  </span>
                  {slot.variant_switch && (
                    <span title="Branch selector — flips which rules apply." style={{ color: "#92400e" }}> *</span>
                  )}
                </div>
              ))}
            </div>
          </details>
        ))}
      </section>
    </main>
  );
}
