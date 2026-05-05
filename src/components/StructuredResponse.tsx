"use client";

import { MarkdownText } from "./MarkdownText";

/**
 * Renderer for the harness-owned response format. Receives the args the model
 * passed to the `respond` tool (or the `decline_out_of_scope` tool) and lays
 * them out deterministically. The model has no opportunity to write prose
 * here — every section is a separate field with its own renderer.
 *
 * If you want to change the look of an assistant reply, change this component.
 * If you want to change WHICH replies the model can produce, change the tool
 * schemas in src/lib/tools.ts.
 */

/** Pre-built shape that the AssistantTurn harness produces from the model's
 *  `respond` args + the engine tool results. Headline is plain text — bolding
 *  is applied by the renderer so the model can't introduce a wrong number. */
export interface StructuredArgs {
  headline: string;
  assumptions?: Array<{ key: string; value: string }>;
  what_could_change?: Array<{ label: string; detail: string }>;
  body?: string;
  action?: string;
}

export function StructuredResponse({ args }: { args: StructuredArgs }) {
  return (
    <div className="bubble bubble-assistant" style={{ maxWidth: "none" }}>
      <Headline text={args.headline} />
      {args.assumptions && args.assumptions.length > 0 && (
        <Section label="Assumptions">
          <List
            items={args.assumptions.map((a, i) => (
              <span key={i}>
                <strong>{a.key}:</strong> <InlineMd text={a.value} />
              </span>
            ))}
          />
        </Section>
      )}
      {args.what_could_change && args.what_could_change.length > 0 && (
        <Section label="What could change this">
          <List
            items={args.what_could_change.map((c, i) => (
              <span key={i}>
                <strong>{c.label}:</strong> <InlineMd text={c.detail} />
              </span>
            ))}
          />
        </Section>
      )}
      {args.body && (
        <p style={{ margin: "8px 0 0", lineHeight: 1.55, fontSize: 14.5 }}>
          <InlineMd text={args.body} />
        </p>
      )}
      {args.action && (
        <p style={{ margin: "14px 0 0", lineHeight: 1.55, fontSize: 14, color: "#374151" }}>
          <InlineMd text={args.action} />
        </p>
      )}
    </div>
  );
}

function Headline({ text }: { text: string }) {
  // Strip surrounding ** if present — the prompt asks for it but the styling
  // already bolds the headline, so we don't double up.
  const cleaned = text.replace(/^\*\*([^*]+)\*\*$/, "$1");
  return (
    <p style={{ margin: "0 0 12px", fontSize: 19, fontWeight: 700, lineHeight: 1.3, letterSpacing: -0.01 }}>
      <InlineMd text={cleaned} />
    </p>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: "#0b1220", marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul style={{ margin: "2px 0 0", paddingLeft: 22, listStyleType: "disc" }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 4, lineHeight: 1.5, fontSize: 14.5 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Inline markdown for the small substring cases (bold, links, code). */
function InlineMd({ text }: { text: string }) {
  return <MarkdownText source={text} />;
}
