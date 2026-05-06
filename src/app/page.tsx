import { Chat } from "@/components/Chat";

export default function Page() {
  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "32px 20px 80px" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>FinBot</h1>
        <p style={{ fontSize: 14.5, color: "#374151", marginTop: 6, lineHeight: 1.5, maxWidth: 720 }}>
          A benefits assistant grounded in the Axiom rules engine. Every dollar amount and eligibility verdict comes from <span className="mono">axiom-rules</span> computing against the encoded Colorado SNAP rulebook — not from the language model on top.
        </p>
      </header>

      <Chat />

      <footer style={{ marginTop: 48, paddingTop: 20, borderTop: "1px solid #e6e6df", fontSize: 12, color: "#6b7280" }}>
        Built on{" "}
        <a className="cite" href="https://github.com/TheAxiomFoundation/axiom-rules" target="_blank" rel="noreferrer">
          axiom-rules
        </a>{" "}
        ·{" "}
        <a className="cite" href="https://github.com/TheAxiomFoundation/rules-us-co" target="_blank" rel="noreferrer">
          rules-us-co
        </a>
        .
      </footer>
    </main>
  );
}
