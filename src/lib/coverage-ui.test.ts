import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type { ToolInvocation } from "ai";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { getCatalog } from "./catalog";
import * as coverage from "./coverage";
import { programCoverageStatuses, summarizeCoverage } from "./coverage";
import { legalIdToUrl } from "./legal-links";
import { MODEL_PROVIDER } from "./model-label";
import { formatValue } from "./money";

function loadComponent<T>(filename: string, modules: Record<string, unknown>): T {
  const file = path.resolve(__dirname, "../components", filename);
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unmocked dependency: ${name}`);
      return modules[name];
    },
  });
  return exports as T;
}

describe("catalog coverage in tool cards", () => {
  const statuses = programCoverageStatuses(getCatalog().programs);
  const { ToolCallCard } = loadComponent<{ ToolCallCard: (props: { invocation: ToolInvocation; programCoverage: typeof statuses }) => React.ReactElement }>("ToolCallCard.tsx", {
    "react/jsx-runtime": jsxRuntime,
    "@/lib/legal-links": { legalIdToUrl }, "@/lib/money": { formatValue },
  });
  const { AssistantTurn } = loadComponent<{ AssistantTurn: (props: { toolInvocations: ToolInvocation[]; programCoverage: typeof statuses }) => React.ReactElement }>("AssistantTurn.tsx", {
    "react/jsx-runtime": jsxRuntime,
    "react": { useState: () => [true, () => undefined] },
    "./ActivityTrail": {}, "./MarkdownText": {}, "./RunningPill": {}, "./ToolCallCard": { ToolCallCard },
  });

  it("shows program status in compute, describe and lookup cards", () => {
    for (const toolName of ["compute", "describe_program", "lookup_value"]) {
      const invocation: ToolInvocation = {
        state: "result", toolCallId: toolName, toolName,
        args: { program: "us-co-snap" }, result: { program: "us-co-snap", outputs: [], inputs: {}, applied: {} },
      };
      const html = renderToStaticMarkup(ToolCallCard({ invocation, programCoverage: statuses }));
      expect(html).toContain(statuses["us-co-snap"]);
      expect(html).toContain("snap_eligible");
    }
  });

  it("shows status for each program in the catalog list", () => {
    const invocation: ToolInvocation = {
      state: "result", toolCallId: "list", toolName: "list_programs", args: {},
      result: { programs: getCatalog().programs },
    };
    const html = renderToStaticMarkup(ToolCallCard({ invocation, programCoverage: statuses }));
    for (const status of Object.values(statuses)) expect(html).toContain(status);
  });

  it("shows each request disclosure once and escapes text", () => {
    const note = "SNAP figures use FY2026 standards.";
    const invocation: ToolInvocation = {
      state: "result", toolCallId: "compute", toolName: "compute", args: { program: "us-ca-snap" },
      result: { applied: { disclosures: [note, note, "<script>alert(1)</script>"], notes: ["Set snap_x_for_household_size=3 to match members[]"] }, outputs: [] },
    };
    const html = renderToStaticMarkup(ToolCallCard({ invocation, programCoverage: statuses }));
    expect(html.split(note)).toHaveLength(2);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    // Model-facing instructions in applied.notes never reach the card.
    expect(html).not.toContain("to match members[]");
  });

  it("shows a repeated program disclosure once per assistant turn, retaining changed assumptions", () => {
    const note = "SNAP figures use FY2026 standards.";
    const invocations: ToolInvocation[] = [1, 2].map((n) => ({
      state: "result", toolCallId: `compute-${n}`, toolName: "compute", args: { program: "us-ny-snap" },
      result: { applied: { disclosures: [note, ...(n === 1 ? [note] : []), `Earned income assumption ${n}`] }, outputs: [] },
    }));
    const html = renderToStaticMarkup(AssistantTurn({ toolInvocations: invocations, programCoverage: statuses }));
    expect(html.split(note)).toHaveLength(2);
    expect(html).toContain("Earned income assumption 1");
    expect(html).toContain("Earned income assumption 2");
  });
});

describe("compact session notice", () => {
  const { SessionNotice } = loadComponent<{ SessionNotice: (props: { modelLabel: string; coverage: ReturnType<typeof summarizeCoverage> }) => React.ReactElement }>("SessionNotice.tsx", {
    "react/jsx-runtime": jsxRuntime,
    "next/link": { default: ({ href, children }: { href: string; children: React.ReactNode }) => jsxRuntime.jsx("a", { href, children }) },
    "@/lib/coverage": coverage, "@/lib/model-label": { MODEL_PROVIDER },
  });

  it("keeps the AI and estimate disclosure visible and analytics details collapsed", () => {
    const html = renderToStaticMarkup(SessionNotice({ modelLabel: "GPT-5.5", coverage: summarizeCoverage(getCatalog().programs) }));
    const visible = html.split("<details")[0];
    expect(visible).toContain("Replies come from an AI (OpenAI");
    expect(visible).toContain("not a person or a government agency");
    expect(visible).toContain("Answers are estimates from encoded rules that may be incomplete");
    // The personal-data warning stays outside the collapsed details.
    expect(visible).toContain("Social Security numbers");
    expect(html).toContain("may keep them for a time");
    expect(html).toContain("parent&rsquo;s or guardian&rsquo;s permission".replace(/&rsquo;/g, "’"));
    expect(html).toContain("<summary>Details</summary>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Google Analytics measures page views, scrolling");
    expect(html).toContain("chat errors masked");
    expect(html).toContain("console recording is disabled");
    expect(html).toContain("may appear in server error logs");
  });
});
