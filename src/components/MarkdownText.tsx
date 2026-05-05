/**
 * Tiny inline markdown renderer for chat output.
 * Handles **bold**, *italic*, `code`, and [link](url). No block elements; the
 * AI SDK gives us short, prose responses, so we just split into paragraphs by
 * blank lines and render each as inline content.
 *
 * Pulling in react-markdown for four constructs would be overkill, and the
 * model's output stays close to the system prompt's "lead with the answer"
 * shape — small surface area to support.
 */
import { Fragment, type ReactNode } from "react";

const TOKEN = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;
const BOLD = /^\*\*([^*]+)\*\*$/;
const ITALIC = /^\*([^*]+)\*$/;
const CODE = /^`([^`]+)`$/;

function renderInline(text: string): ReactNode[] {
  const parts = text.split(TOKEN).filter(Boolean);
  return parts.map((part, i) => {
    let m;
    if ((m = part.match(LINK))) {
      return (
        <a
          key={i}
          href={m[2]}
          target="_blank"
          rel="noreferrer"
          style={{ color: "#075985", textDecoration: "underline" }}
        >
          {m[1]}
        </a>
      );
    }
    if ((m = part.match(BOLD))) return <strong key={i}>{m[1]}</strong>;
    if ((m = part.match(ITALIC))) return <em key={i}>{m[1]}</em>;
    if ((m = part.match(CODE)))
      return (
        <code key={i} className="mono" style={{ background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontSize: "0.92em" }}>
          {m[1]}
        </code>
      );
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function MarkdownText({ source }: { source: string }) {
  const paragraphs = source.split(/\n\s*\n/);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ whiteSpace: "pre-wrap", margin: i === 0 ? 0 : "8px 0 0" }}>
          {renderInline(p)}
        </p>
      ))}
    </>
  );
}
