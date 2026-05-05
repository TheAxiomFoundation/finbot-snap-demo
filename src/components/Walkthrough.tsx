/**
 * Walkthrough tab — static documentation of the tools the chat layer uses.
 * No forms, no Run buttons, no state. Just an explainer of what each tool
 * does, what it expects, and where the underlying content lives in the
 * axiom ecosystem.
 *
 * If you want to actually exercise the tools, the chat tab and the
 * side-by-side tab both call them live.
 */

const ENGINE_REPO = "https://github.com/TheAxiomFoundation/axiom-rules";
const RULES_US_REPO = "https://github.com/TheAxiomFoundation/rules-us";
const RULES_US_CO_REPO = "https://github.com/TheAxiomFoundation/rules-us-co";
const CO_SNAP_RULESPEC =
  "https://github.com/TheAxiomFoundation/rules-us-co/blob/main/policies/cdhs/snap/fy-2026-benefit-calculation.yaml";
const CORPUS_APP = "https://app.axiom-foundation.org";
const TOOLS_SOURCE =
  "https://github.com/TheAxiomFoundation/finbot-snap-demo/blob/main/src/lib/tools.ts";
const MODAL_APP =
  "https://github.com/TheAxiomFoundation/finbot-snap-demo/blob/main/modal_app.py";

interface ToolDoc {
  name: string;
  blurb: string;
  inputs: Array<{ name: string; type: string; note?: string }>;
  output: string;
  callsOut: Array<{ label: string; href: string }>;
}

const TOOLS: ToolDoc[] = [
  {
    name: "list_encoded_outputs",
    blurb:
      "Discovery. Lists which programs are encoded today (currently just Colorado SNAP, FY 2026 benefit calculation), and lets the model search across the 168 derived outputs in the program by name. The model calls this first to confirm a program exists and to find the legal_id of any specific encoded value.",
    inputs: [
      { name: "jurisdiction", type: "string?", note: "e.g. \"us-co\" or \"us\"; optional filter" },
      { name: "search", type: "string?", note: "case-insensitive substring search over the 168 output names" },
    ],
    output:
      "{ programs: [...], catalog_size, encoded_outputs_total, search_matches?: [{ legal_id, name, entity, semantics, unit }] }",
    callsOut: [
      { label: "Source — src/lib/catalog.ts", href: "https://github.com/TheAxiomFoundation/finbot-snap-demo/blob/main/src/lib/catalog.ts" },
      { label: "rules-us-co — CO SNAP rulespec", href: CO_SNAP_RULESPEC },
    ],
  },
  {
    name: "compute_co_snap",
    blurb:
      "Whole-household calculation. Builds a complete engine request from a small set of friendly facts (household size, monthly wages, shelter costs, utilities flag, age, citizenship), runs the FY-2026 Colorado SNAP rulespec, and returns the regular monthly allotment plus eligibility judgments and intermediate values (gross income, net income, the four deductions). Every dollar amount in the chat reply must come from this tool — the model never estimates.",
    inputs: [
      { name: "household_size", type: "integer" },
      { name: "monthly_earnings_per_adult", type: "number?" },
      { name: "monthly_unearned_income", type: "number?" },
      { name: "monthly_shelter_costs", type: "number?" },
      { name: "pays_separate_heating_or_cooling", type: "boolean?" },
      { name: "liquid_resources", type: "number?" },
      { name: "oldest_member_age", type: "integer?" },
      { name: "any_member_elderly_or_disabled", type: "boolean?" },
      { name: "primary_member_is_us_citizen", type: "boolean?" },
    ],
    output:
      "{ outputs: { snap_regular_month_allotment, snap_eligible, snap_resource_eligible, snap_income_eligible, gross_income, snap_net_income, snap_maximum_allotment, snap_standard_utility_allowance, snap_standard_deduction, snap_earned_income_deduction, excess_shelter_deduction, shelter_costs }, citations: [...], applied_facts }",
    callsOut: [
      { label: "rules-us-co — CO SNAP rulespec", href: CO_SNAP_RULESPEC },
      { label: "axiom-rules engine", href: ENGINE_REPO },
      { label: "Source — src/lib/programs/co-snap.ts", href: "https://github.com/TheAxiomFoundation/finbot-snap-demo/blob/main/src/lib/programs/co-snap.ts" },
    ],
  },
  {
    name: "lookup_value",
    blurb:
      "Read any of the 168 encoded outputs by legal_id. Used for questions about a specific encoded parameter — \"what's the gross income limit for a household of 4?\", \"what's the standard deduction?\" — that compute_co_snap doesn't surface but are reachable in the rule graph. The model finds the right legal_id with list_encoded_outputs(search), then calls lookup_value with that id and any facts the value depends on.",
    inputs: [
      { name: "legal_id", type: "string", note: "full legal_id with #name suffix, from list_encoded_outputs" },
      { name: "facts", type: "CoSnapFacts?", note: "household_size matters for size-indexed parameters like income limits" },
    ],
    output:
      "{ legal_id, name, entity, dtype, unit, semantics, value, source, applied_facts }",
    callsOut: [
      { label: "axiom-rules engine", href: ENGINE_REPO },
      { label: "Source — src/lib/programs/co-snap.ts", href: "https://github.com/TheAxiomFoundation/finbot-snap-demo/blob/main/src/lib/programs/co-snap.ts" },
    ],
  },
  {
    name: "rank_next_question",
    blurb:
      "Variance-driving missing fact. For each candidate unknown the user hasn't yet specified, runs compute_co_snap twice with the bracket extremes and measures how many dollars the SNAP allotment moves between them. Returns the candidates ordered by variance, so the chat asks the single highest-impact follow-up rather than a generic intake. Runs in parallel with compute_co_snap on every household-benefit question.",
    inputs: [
      { name: "facts", type: "CoSnapFacts", note: "facts the user has already provided; ranking happens over the rest" },
    ],
    output: "{ ranked: [{ question, why, fact_key, variance_dollars, bracket: { values, labels, allotments } }] }",
    callsOut: [
      { label: "Source — src/lib/ranking.ts", href: "https://github.com/TheAxiomFoundation/finbot-snap-demo/blob/main/src/lib/ranking.ts" },
    ],
  },
  {
    name: "fetch_citation",
    blurb:
      "Pulls the legal text behind a legal_id from axiom-foundation.org's corpus API. Resolution prefers the corpus_citation_path declared in the source rulespec module (so a USDA COLA file at us:policies/usda/snap/fy-2026-cola/income-eligibility-standards correctly routes to the corresponding USDA guidance document at us/guidance/usda/fns/...). Falls back to a structural rewrite when no path is declared. Reports resolution status so the model can be honest when no body excerpt is available.",
    inputs: [
      { name: "legal_id", type: "string", note: "e.g. us:statutes/7/2017/a or us-co:regulations/10-ccr-2506-1/4.207.3" },
    ],
    output: "{ legal_id, citation_path, heading, body_excerpt, url, resolved, resolution: \"rulespec_declared\" | \"structural_fallback\" | \"not_found\" }",
    callsOut: [
      { label: "axiom-corpus app", href: CORPUS_APP },
      { label: "Source — src/lib/citations.ts", href: "https://github.com/TheAxiomFoundation/finbot-snap-demo/blob/main/src/lib/citations.ts" },
    ],
  },
];

export function Walkthrough() {
  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, color: "#6b7280", letterSpacing: 0.05 }}>
          REFERENCE · WHAT THE CHAT CALLS
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>The five tools the LLM has access to</h2>
        <p style={{ fontSize: 13.5, color: "#374151", marginTop: 6, lineHeight: 1.55 }}>
          The chat layer is OpenAI on top of these five tools, registered in{" "}
          <a className="cite" href={TOOLS_SOURCE} target="_blank" rel="noreferrer">src/lib/tools.ts</a>
          . Together they cover the discovery, computation, and citation needs the model has when answering a benefits question — and they're the only path to a dollar amount in any reply.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <Pill href={ENGINE_REPO}>axiom-rules engine ↗</Pill>
          <Pill href={RULES_US_REPO}>rules-us ↗</Pill>
          <Pill href={RULES_US_CO_REPO}>rules-us-co ↗</Pill>
          <Pill href={CO_SNAP_RULESPEC}>CO SNAP rulespec ↗</Pill>
          <Pill href={CORPUS_APP}>axiom-corpus app ↗</Pill>
          <Pill href={MODAL_APP}>Modal engine wrapper ↗</Pill>
        </div>
      </div>

      {TOOLS.map((tool) => (
        <ToolCard key={tool.name} tool={tool} />
      ))}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolDoc }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span className="mono" style={{ fontSize: 11, background: "#0b1220", color: "white", padding: "3px 8px", borderRadius: 6, fontWeight: 700 }}>
          TOOL
        </span>
        <span className="mono" style={{ fontSize: 14.5, fontWeight: 700 }}>{tool.name}</span>
      </div>
      <p style={{ fontSize: 13.5, color: "#374151", lineHeight: 1.55, margin: 0 }}>{tool.blurb}</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 14 }}>
        <div>
          <div className="mono" style={{ fontSize: 11, color: "#6b7280", letterSpacing: 0.04, marginBottom: 6 }}>INPUTS</div>
          <div className="flex flex-col gap-1">
            {tool.inputs.map((p) => (
              <div key={p.name} style={{ fontSize: 12 }}>
                <span className="mono" style={{ fontWeight: 700 }}>{p.name}</span>
                <span className="mono" style={{ color: "#075985" }}> : {p.type}</span>
                {p.note && <div style={{ color: "#6b7280", fontSize: 11.5, marginTop: 1, marginLeft: 12 }}>{p.note}</div>}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 11, color: "#6b7280", letterSpacing: 0.04, marginBottom: 6 }}>OUTPUT</div>
          <div className="mono" style={{ fontSize: 11.5, color: "#374151", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
            {tool.output}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px dashed #e6e6df", display: "flex", flexWrap: "wrap", gap: 12 }}>
        {tool.callsOut.map((link) => (
          <a key={link.href} className="cite" href={link.href} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            {link.label} ↗
          </a>
        ))}
      </div>
    </section>
  );
}

function Pill({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mono"
      style={{
        fontSize: 11.5,
        padding: "5px 10px",
        background: "white",
        border: "1px solid #e6e6df",
        borderRadius: 999,
        color: "#0b1220",
        textDecoration: "none",
      }}
    >
      {children}
    </a>
  );
}
