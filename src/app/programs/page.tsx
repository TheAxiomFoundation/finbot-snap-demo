import type { Metadata } from "next";
import Link from "next/link";

import { getCatalog } from "@/lib/catalog";
import { programDisclosures } from "@/lib/catalog-overlay";
import { jurisdictionCoverageStatus, programCoverageStatus } from "@/lib/coverage";

export const metadata: Metadata = {
  title: "Encoded programs — Axiom rules engine",
  description:
    "Every program encoded in the rulespec-us release the chatbot runs on, grouped by jurisdiction.",
};

export default function ProgramsPage() {
  const catalog = getCatalog();
  const byJurisdiction = new Map<string, typeof catalog.programs>();
  for (const program of catalog.programs) {
    if (!byJurisdiction.has(program.jurisdiction)) byJurisdiction.set(program.jurisdiction, []);
    byJurisdiction.get(program.jurisdiction)!.push(program);
  }
  const jurisdictions = [...byJurisdiction.keys()].sort((a, b) =>
    a === "us" ? -1 : b === "us" ? 1 : a.localeCompare(b)
  );
  const specUrl = (specPath: string) =>
    `https://github.com/${catalog.repo}/blob/${catalog.corpus_sha}/${specPath}`;

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "40px 20px 80px" }}>
      <div style={{ marginBottom: 8 }}>
        <Link href="/" className="mono" style={{ fontSize: 13, textDecoration: "underline", textUnderlineOffset: 3 }}>
          ← chat
        </Link>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>Encoded programs</h1>
      <p style={{ color: "#374151", fontSize: 14, lineHeight: 1.55, maxWidth: 720, margin: "4px 0 8px" }}>
        The chatbot can compute only these programs, whose rules Axiom encoded from statutes,
        regulations, and agency guidance in the rulespec-us release it pins. Encodings can contain
        errors, and outputs marked incomplete are flagged in their program specs as not fully encoded.
      </p>
      <p className="mono" style={{ fontSize: 12, color: "#6b7280", marginBottom: 24 }}>
        release {catalog.release_tag} · corpus{" "}
        <a
          className="cite"
          href={`https://github.com/${catalog.repo}/tree/${catalog.corpus_sha}`}
          target="_blank"
          rel="noreferrer"
        >
          {catalog.corpus_sha.slice(0, 12)}
        </a>{" "}
        · {catalog.programs.length} programs · {jurisdictions.length} jurisdictions
      </p>

      {jurisdictions.map((jurisdiction) => {
        const programs = byJurisdiction.get(jurisdiction)!;
        return (
          <section key={jurisdiction} style={{ marginBottom: 28 }}>
            <h2 className="mono" style={{ fontSize: 14, fontWeight: 700, color: "#374151", marginBottom: 10 }}>
              {jurisdiction} · {programs.length} program{programs.length === 1 ? "" : "s"}
            </h2>
            <p style={{ fontSize: 12, color: "#6b7280", margin: "-4px 0 10px" }}>
              {jurisdictionCoverageStatus(programs)}
            </p>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {programs.map((program) => (
                <div key={program.slug} className="card" style={{ padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <Link href={`/programs/${program.slug}`} style={{ fontWeight: 600, fontSize: 15 }}>
                      {program.display_name}
                    </Link>
                    <span className="mono" style={{ fontSize: 11, color: "#6b7280" }}>{program.evaluation_period}</span>
                  </div>
                  <div className="tool-coverage-status">{programCoverageStatus(program)}</div>
                  {programDisclosures(program).map((note) => (
                    <p key={note} className="tool-coverage-status">{note}</p>
                  ))}
                  <div className="mono" style={{ fontSize: 11, color: "#6b7280", margin: "4px 0 8px" }}>
                    {program.slug} · {program.counts.derived} rules · {program.counts.parameters} parameters
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {program.certified_outputs.map((name) => (
                      <span key={name} className="badge badge-source" style={{ fontSize: 10 }}>
                        {name}
                      </span>
                    ))}
                    {program.acknowledged_incomplete.map((name) => (
                      <span
                        key={`inc-${name}`}
                        className="badge"
                        style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}
                        title="Flagged in the program spec as not fully encoded."
                      >
                        {name} · incomplete
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <a
                      className="cite"
                      style={{ fontSize: 11 }}
                      href={specUrl(program.spec_path)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      spec on GitHub
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}
