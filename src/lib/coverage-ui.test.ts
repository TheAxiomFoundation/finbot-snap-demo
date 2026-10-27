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

  it("shows the failed gate behind a $0 output", () => {
    const gate = {
      name: "eitc_allowed",
      value: "not_holds",
      legal_id: "us:statutes/26/32#eitc_allowed",
      requires: [{ slot: "taxpayer_includes_required_social_security_number_on_return", value: true }],
      requires_any: [{ rule: "eitc_demographic_eligible", any_of: [[{ slot: "eitc_child_count", op: "gt", value: 0, computed: true }]] }],
    };
    const invocation: ToolInvocation = {
      state: "result", toolCallId: "compute", toolName: "compute", args: { program: "us-fiit" },
      result: {
        primary_output: "income_tax_before_refundable_credits", applied: {},
        outputs: [
          { name: "income_tax_before_refundable_credits", label: "Income tax", value: 1585, unit: "USD", semantics: "scalar" },
          { name: "eitc", label: "Eitc", value: 0, unit: "USD", semantics: "scalar", zero_because: [gate] },
        ],
      },
    };
    const html = renderToStaticMarkup(ToolCallCard({ invocation, programCoverage: statuses }));
    expect(html).toContain("0 because Eitc allowed ✗ does not hold");
    expect(html).toContain("requires: taxpayer_includes_required_social_security_number_on_return=true");
    expect(html).toContain("eitc_child_count&gt;0 (computed)");
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

  it("shows the amended statute a compute's failed check applied, in the card and in Sources", () => {
    // The shape computeProgram returns for the Florida refugee starter.
    const statute = "https://app.axiom-foundation.org/us/statute/7/2015/f";
    const amended = (outcome: Record<string, unknown> = {}) => ({
      legal_id: "us:statutes/7/2015/f", citation: "7 U.S.C. 2015(f)", enacted_by: "P.L. 119-21, §10108",
      effective: "2025-07-04", applies_from: "2025-08-01", url: statute, note: "…", ...outcome,
    });
    const failed = (outcome?: Record<string, unknown>) => [{
      name: "snap_member_citizenship_or_alien_status_eligible", source: "7 CFR 273.4(a), 7 CFR 273.4(b)(2)",
      legal_id: "us:regulations/7-cfr/273/4#snap_member_citizenship_or_alien_status_eligible", amended_by: amended(outcome),
    }];
    const perMember = { changed_for_members: [1], unchanged_for_members: [2] };
    const compute = (member_checks?: unknown[]): ToolInvocation => ({
      state: "result", toolCallId: "compute", toolName: "compute", args: { program: "us-fl-snap" },
      result: {
        program: "us-fl-snap", primary_output: "snap_benefit", applied: {}, member_count: 2,
        outputs: [
          { name: "snap_benefit", label: "Snap benefit", value: 0, unit: "USD", semantics: "scalar" },
          { name: "snap_eligible", label: "Snap eligible", value: "not_holds", semantics: "judgment", failed_because: failed(perMember) },
          { name: "snap_eligible_core", label: "Snap eligible core", value: "not_holds", semantics: "judgment", failed_because: failed(perMember) },
        ],
        ...(member_checks && { member_checks }),
        citations: [{ id: "us:statutes/7/2015/f", url: statute }],
      },
    });
    const invocation = compute([
      { member: 1, checks: [{ name: "snap_member_eligible", value: "not_holds", failed_because: failed({ changed_outcome: true }) }] },
      { member: 2, checks: [{ name: "snap_member_eligible", value: "not_holds", failed_because: failed({ changed_outcome: false }) }] },
    ]);
    const html = renderToStaticMarkup(ToolCallCard({ invocation, programCoverage: statuses }));
    expect(html).toContain(`href="${statute}"`);
    expect(html).toContain("as amended by P.L. 119-21, §10108 (effective 2025-07-04; encoded for periods from 2025-08-01)");
    // Once per member: the member rows carry it, so the household line,
    // which would repeat them, is left out.
    expect(html.split("Snap member citizenship or alien status eligible applies")).toHaveLength(3);
    expect(html).toContain("the amendment changed this check&#x27;s result");
    expect(html).toContain("this check gives the same result under the earlier formula");
    expect(html).not.toContain("changed this result");

    // With no member checks (us-co-snap), the household line says it per member.
    const household = renderToStaticMarkup(ToolCallCard({ invocation: compute(), programCoverage: statuses }));
    expect(household.split("Snap member citizenship or alien status eligible applies")).toHaveLength(2);
    expect(household).toContain("the amendment changed this check for member 1; same under the earlier formula for member 2");

    const turn = renderToStaticMarkup(AssistantTurn({ toolInvocations: [invocation], programCoverage: statuses }));
    expect(turn.split("Sources:")[1]).toContain(`href="${statute}"`);
  });

  it("shows a lookup's amended statute and whether it changed the value", () => {
    const invocation: ToolInvocation = {
      state: "result", toolCallId: "lookup", toolName: "lookup_value", args: { program: "us-fl-snap" },
      result: {
        program: "us-fl-snap", name: "snap_member_citizenship_or_alien_status_eligible", value: "not_holds", entity: "Person",
        legal_id: "us:regulations/7-cfr/273/4#snap_member_citizenship_or_alien_status_eligible",
        url: "https://app.axiom-foundation.org/us/regulation/7/273/4", applied: {},
        amended_by: {
          legal_id: "us:statutes/7/2015/f", citation: "7 U.S.C. 2015(f)", enacted_by: "P.L. 119-21, §10108",
          applies_from: "2025-08-01", url: "https://app.axiom-foundation.org/us/statute/7/2015/f", changed_outcome: false,
        },
      },
    };
    const html = renderToStaticMarkup(ToolCallCard({ invocation, programCoverage: statuses }));
    expect(html).toContain("Applies <a");
    expect(html).toContain("(encoded for periods from 2025-08-01) · this check gives the same result under the earlier formula");
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
