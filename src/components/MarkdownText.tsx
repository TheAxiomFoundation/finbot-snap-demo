/**
 * Tiny markdown renderer for chat output. Block-level: paragraphs and bullet
 * lists. Inline: **bold**, *italic*, `code`, [link](url). Plus a couple of
 * typographic touches the chat needs:
 *   - The first block, if it is a single bold-only line, becomes the headline
 *     (larger size, more bottom margin) — that's how the model sets up an
 *     answer.
 *   - Lines that are entirely bold (e.g. "**Assumptions:**") render as small
 *     section labels with a touch of breathing room above.
 *
 * Pulling in react-markdown for this would be overkill — the surface stays
 * small because the system prompt keeps replies short and structural.
 */
import { Fragment, type ReactNode } from "react";

const TOKEN = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;
const BOLD = /^\*\*([^*]+)\*\*$/;
const ITALIC = /^\*([^*]+)\*$/;
const CODE = /^`([^`]+)`$/;
const BOLD_ONLY_LINE = /^\s*\*\*([^*]+)\*\*\s*$/;
const BULLET_LINE = /^\s*[-*]\s+(.*)$/;
const ORDERED_LINE = /^\s*\d+\.\s+(.*)$/;

function renderInline(text: string): ReactNode[] {
  const parts = text.split(TOKEN).filter(Boolean);
  return parts.map((part, i) => {
    let m;
    if ((m = part.match(LINK))) {
      return (
        <a key={i} href={m[2]} target="_blank" rel="noreferrer" style={{ color: "#075985", textDecoration: "underline" }}>
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

type Block =
  | { type: "headline"; text: string }
  | { type: "section_label"; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] };

function parse(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let listOrdered = false;

  function flushPara() {
    if (para.length) {
      // If the paragraph is a single bold-only line, treat it as a section
      // label rather than body text — gives the next list/paragraph a header.
      if (para.length === 1) {
        const m = para[0].match(BOLD_ONLY_LINE);
        if (m) {
          blocks.push({ type: "section_label", text: m[1] });
          para = [];
          return;
        }
      }
      blocks.push({ type: "paragraph", lines: para });
      para = [];
    }
  }
  function flushList() {
    if (list.length) {
      blocks.push({ type: "list", ordered: listOrdered, items: list });
      list = [];
      listOrdered = false;
    }
  }

  for (const raw of lines) {
    const line = raw;
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const bullet = line.match(BULLET_LINE);
    const ordered = bullet ? null : line.match(ORDERED_LINE);
    if (bullet) {
      flushPara();
      // Switch list type if we were collecting an ordered list before.
      if (listOrdered && list.length) flushList();
      list.push(bullet[1]);
      listOrdered = false;
    } else if (ordered) {
      flushPara();
      if (!listOrdered && list.length) flushList();
      list.push(ordered[1]);
      listOrdered = true;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  // If the very first block is a one-line bold paragraph, promote to headline.
  if (blocks[0]?.type === "paragraph" && blocks[0].lines.length === 1) {
    const m = blocks[0].lines[0].match(BOLD_ONLY_LINE);
    if (m) blocks[0] = { type: "headline", text: m[1] };
  }
  return blocks;
}

export function MarkdownText({ source }: { source: string }) {
  const blocks = parse(source);
  return (
    <>
      {blocks.map((block, i) => {
        const first = i === 0;
        if (block.type === "headline") {
          return (
            <p
              key={i}
              style={{
                margin: first ? "0 0 10px" : "12px 0 10px",
                fontSize: 16.5,
                fontWeight: 700,
                lineHeight: 1.4,
              }}
            >
              {block.text}
            </p>
          );
        }
        if (block.type === "section_label") {
          return (
            <div
              key={i}
              style={{
                margin: "12px 0 4px",
                fontSize: 13,
                fontWeight: 700,
                color: "#374151",
                letterSpacing: 0.01,
              }}
            >
              {block.text.replace(/:\s*$/, "")}
            </div>
          );
        }
        if (block.type === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag
              key={i}
              style={{
                margin: "2px 0 6px",
                paddingLeft: 22,
                listStyleType: block.ordered ? "decimal" : "disc",
              }}
            >
              {block.items.map((item, j) => (
                <li key={j} style={{ marginBottom: 4, lineHeight: 1.5 }}>
                  {renderInline(item)}
                </li>
              ))}
            </Tag>
          );
        }
        // paragraph
        return (
          <p
            key={i}
            style={{
              margin: first ? 0 : "8px 0 0",
              lineHeight: 1.55,
            }}
          >
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {renderInline(line)}
                {j < block.lines.length - 1 && <br />}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
