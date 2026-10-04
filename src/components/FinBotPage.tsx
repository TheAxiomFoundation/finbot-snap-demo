"use client";

import Link from "next/link";

import { Chat } from "@/components/Chat";
import { SessionNotice } from "@/components/SessionNotice";
import type { CoverageSummary } from "@/lib/coverage";

export function FinBotPage({
  modelLabel,
  coverage,
}: {
  modelLabel: string;
  coverage: CoverageSummary;
}) {
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand-group">
            <a
              href="https://axiom.org"
              className="brand-link"
              aria-label="Axiom Foundation"
            >
              <img
                src="/gallery/chatbot/axiom-foundation.svg"
                alt="Axiom Foundation"
                className="brand-axiom"
              />
            </a>
            <Link href="/" className="brand-title">
              <span className="brand-name">Chatbot</span>
            </Link>
          </span>
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            <a href="https://axiom.org/demos" className="topbar-link">
              All demos
            </a>
            <Link href="/programs" className="topbar-link">
              Programs
            </Link>
          </span>
        </div>
      </header>

      <main style={{ maxWidth: 980, margin: "0 auto", padding: "56px 20px 80px" }}>
        <div className="page-intro" style={{ marginBottom: 36 }}>
          <h1>
            An AI benefits assistant that calculates with the <em>Axiom rules engine</em>.
          </h1>
          <p>
            Ask about a benefit or a tax. The assistant is instructed to take every
            dollar amount and eligibility result from the Axiom rules engine, which
            runs rules Axiom encoded from statutes, regulations, and agency
            guidance, rather than from the model&rsquo;s memory. Expand the tool
            calls under an answer to see the calculation.
          </p>
        </div>

        <SessionNotice modelLabel={modelLabel} coverage={coverage} />

        <Chat />
      </main>
    </>
  );
}
