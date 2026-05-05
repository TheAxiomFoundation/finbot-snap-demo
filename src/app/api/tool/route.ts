/**
 * Generic tool dispatcher. Routes to the same underlying functions that power
 * the AI SDK tools the chat layer uses. The Walkthrough tab calls this so it's
 * literally exercising the same code path as the LLM — not a parallel
 * implementation, not pre-canned data.
 *
 * If you add or rename a tool in src/lib/tools.ts, update the switch below.
 */
import { CATALOG, programsForJurisdiction } from "@/lib/catalog";
import { fetchCitation } from "@/lib/citations";
import { compute, lookupValue, type CoSnapFacts } from "@/lib/programs/co-snap";
import { CO_SNAP_BASE } from "@/lib/programs/co-snap-base";
import { rankNextQuestions } from "@/lib/ranking";

export const runtime = "nodejs";
export const maxDuration = 30;

interface Body {
  tool: string;
  args?: Record<string, unknown>;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (err) {
    return Response.json({ error: `bad request: ${(err as Error).message}` }, { status: 400 });
  }
  if (!body.tool) {
    return Response.json({ error: "missing tool" }, { status: 400 });
  }
  const args = body.args ?? {};

  try {
    switch (body.tool) {
      case "list_encoded_outputs": {
        const jurisdiction = typeof args.jurisdiction === "string" ? args.jurisdiction : undefined;
        const search = typeof args.search === "string" ? args.search : undefined;
        const programs = programsForJurisdiction(jurisdiction);
        const all = CO_SNAP_BASE.all_outputs as ReadonlyArray<{
          name: string; id: string; entity: string; semantics: string; unit?: string | null;
        }>;
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const matches = search
          ? (() => {
              const tokens = normalize(search).split(" ").filter(Boolean);
              return all.filter((o) => {
                const hay = " " + normalize(o.name) + " ";
                return tokens.every((t) => hay.includes(t));
              });
            })()
          : null;
        return Response.json({
          programs: programs.map((p) => ({
            slug: p.slug,
            jurisdiction: p.jurisdiction,
            display_name: p.display_name,
            scope: p.scope,
            rulespec_path: p.rulespec_path,
            outputs: p.outputs,
            primary_output: p.primary_output,
          })),
          catalog_size: CATALOG.length,
          encoded_outputs_total: all.length,
          ...(matches !== null && {
            search_matches: matches.slice(0, 24).map((o) => ({
              legal_id: o.id, name: o.name, entity: o.entity, semantics: o.semantics, unit: o.unit ?? null,
            })),
            truncated: matches.length > 24,
            search_matches_total: matches.length,
          }),
        });
      }

      case "compute_co_snap": {
        const facts = (args.facts ?? args) as CoSnapFacts;
        return Response.json(await compute(facts));
      }

      case "lookup_value": {
        const legal_id = typeof args.legal_id === "string" ? args.legal_id : "";
        if (!legal_id) return Response.json({ error: "missing legal_id" }, { status: 400 });
        const facts = (args.facts ?? {}) as CoSnapFacts;
        return Response.json(await lookupValue(legal_id, facts));
      }

      case "rank_next_question": {
        const facts = (args.facts ?? args) as CoSnapFacts;
        const ranked = await rankNextQuestions(facts);
        return Response.json({ ranked });
      }

      case "fetch_citation": {
        const legal_id = typeof args.legal_id === "string" ? args.legal_id : "";
        if (!legal_id) return Response.json({ error: "missing legal_id" }, { status: 400 });
        return Response.json(await fetchCitation(legal_id));
      }

      default:
        return Response.json({ error: `unknown tool: ${body.tool}` }, { status: 400 });
    }
  } catch (err) {
    console.error(`[finbot] /api/tool ${body.tool} failed:`, err);
    return Response.json(
      { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
      { status: 500 }
    );
  }
}
