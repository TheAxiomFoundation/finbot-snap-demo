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
/** ATX-style heading: 1-6 leading hashes, a space, then the title text.
 *  The plain-LLM side (no tools, no system prompt instructing markdown
 *  shape) commonly emits these — without this rule we'd render the
 *  literal `###` as text. */
const HEADING_LINE = /^\s*(#{1,6})\s+(.+?)\s*$/;
/** GFM pipe-table row (`| a | b |`) and its alignment separator
 *  (`|---|---:|`). The plain-LLM side emits these freely. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

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
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[] | null; aligns: Array<"left" | "center" | "right">; rows: string[][] };

function parse(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let listOrdered = false;
  let table: string[] = [];

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
  function flushTable() {
    if (!table.length) return;
    const rawRows = table;
    table = [];
    // Header when the second line is an alignment separator; otherwise treat
    // every row as body so partial/streaming tables still render sensibly.
    let header: string[] | null = null;
    let aligns: Array<"left" | "center" | "right"> = [];
    let bodyLines = rawRows;
    if (rawRows.length >= 2 && TABLE_SEPARATOR.test(rawRows[1])) {
      header = splitTableRow(rawRows[0]);
      aligns = splitTableRow(rawRows[1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });
      bodyLines = rawRows.slice(2);
    }
    const rows = bodyLines.map(splitTableRow);
    const width = Math.max(header?.length ?? 0, ...rows.map((r) => r.length), aligns.length, 1);
    while (aligns.length < width) aligns.push("left");
    blocks.push({ type: "table", header, aligns, rows });
  }

  for (const raw of lines) {
    const line = raw;
    if (line.trim() === "") {
      flushPara();
      flushList();
      flushTable();
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flushPara();
      flushList();
      table.push(line);
      continue;
    }
    flushTable();
    const heading = line.match(HEADING_LINE);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
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
  flushTable();

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
                margin: first ? "0 0 12px" : "14px 0 12px",
                fontSize: 19,
                fontWeight: 700,
                lineHeight: 1.3,
                letterSpacing: -0.01,
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
                margin: "14px 0 6px",
                fontSize: 14.5,
                fontWeight: 700,
                color: "#0b1220",
              }}
            >
              {block.text.replace(/:\s*$/, "")}
            </div>
          );
        }
        if (block.type === "heading") {
          // Map levels to a small set of sizes that match the rest of the
          // bubble's typographic scale. h1/h2 get the headline size; h3+
          // collapse to the section-label size so a wall of `###` from
          // the plain model doesn't dwarf the surrounding body.
          const isLarge = block.level <= 2;
          return (
            <div
              key={i}
              style={{
                margin: first ? "0 0 8px" : "14px 0 6px",
                fontSize: isLarge ? 17 : 14.5,
                fontWeight: 700,
                lineHeight: 1.3,
                color: "#0b1220",
              }}
            >
              {renderInline(block.text)}
            </div>
          );
        }
        if (block.type === "table") {
          const cellStyle = (col: number): React.CSSProperties => ({
            padding: "4px 10px",
            textAlign: block.aligns[col] ?? "left",
            borderBottom: "1px solid #eeeee8",
            fontSize: 13,
            lineHeight: 1.45,
          });
          return (
            <div key={i} style={{ overflowX: "auto", margin: "8px 0" }}>
              <table style={{ borderCollapse: "collapse", minWidth: 280 }}>
                {block.header && (
                  <thead>
                    <tr>
                      {block.header.map((cell, c) => (
                        <th
                          key={c}
                          style={{
                            ...cellStyle(c),
                            fontWeight: 600,
                            color: "#374151",
                            borderBottom: "1.5px solid #d7d8d0",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {renderInline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c} style={cellStyle(c)}>
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
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
