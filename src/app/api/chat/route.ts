/**
 * Two-phase chat handler. The harness owns the response shape:
 *
 *   Phase 1 (engine pass): the model calls list_encoded_outputs, compute_co_snap,
 *   lookup_value, rank_next_question, fetch_citation as needed.
 *
 *   Phase 2 (response pass): a separate model call with tool_choice forced to
 *   `respond` or `decline_out_of_scope`. Sees phase 1's full transcript and
 *   has to pick one — there's no "stop without producing output" path.
 *
 * The two-phase shape decouples tool calling from response rendering. The
 * model can't bail silently like it did when respond was just one of several
 * tools it could optionally use. Both phases are non-streaming and emitted
 * as a single data-stream the client renders incrementally — losing the
 * streaming text animation but guaranteeing structured output.
 */
import { generateText, type CoreMessage } from "ai";

import { finbotModel } from "@/lib/model";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { tools } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 90;

const { respond, decline_out_of_scope, ...engineTools } = tools;
const responseTools = { respond, decline_out_of_scope };

const RESPONSE_SYSTEM_PROMPT = `You are FinBot. The previous turn ran any engine tools needed; now you produce the user-facing response.

You MUST call exactly one of:
- \`respond\` — the normal benefits answer.
- \`decline_out_of_scope\` — when the user's question was about a program Axiom hasn't encoded (federal EITC, Medicaid, another state's SNAP) or a non-benefits topic.

For \`respond\`, you pick a \`kind\` and the harness builds the headline FROM YOUR ENGINE RESULTS. You do NOT write the headline string yourself for the common cases. Pick:
- \`kind: "household_benefit"\` when you ran compute_co_snap and the user asked what THEY would get. The harness reads snap_regular_month_allotment + snap_eligible from compute_co_snap and builds the headline — including the "Not eligible — the X test failed" form when snap_eligible is "not_holds". USE THIS for not-eligible cases too; do NOT fall back to free_form for denials.
- \`kind: "parameter_value"\` when you ran lookup_value for a specific encoded threshold/limit/rate. The harness reads the value from lookup_value and builds the headline. Pass \`parameter_label\` for context (e.g., "gross income limit for a household of 4").
- \`kind: "free_form"\` only as a last resort, when neither path applies. Then pass \`custom_headline\` with markdown bold around the key value.

Other fields you still own:
- assumptions: facts you inferred, with derivations. Skip if no inference was needed.
- what_could_change: FACTS about the user's situation, from rank_next_question variances. Never include capabilities ("I can fetch..." — those go in action).
- action: a closing one-liner.

Don't editorialize. Don't characterize numbers as small/large/surprising/fair. Don't volunteer mechanics ("this is low because...") unless the user asked.`;

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not set on the server. Add it to .env.local and restart." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  const { messages } = (await req.json()) as { messages: CoreMessage[] };

  // ── Phase 1: engine pass ─────────────────────────────────────────────────
  let phase1;
  try {
    phase1 = await generateText({
      model: finbotModel(),
      system: SYSTEM_PROMPT,
      messages,
      tools: engineTools,
      maxSteps: 6,
      temperature: 0.2,
    });
  } catch (err) {
    console.error("[finbot] phase 1 engine pass failed:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Phase 2: forced response pass ────────────────────────────────────────
  // We hand phase 1's tool calls + results to phase 2 as a serialized JSON
  // appendix on a user message, instead of passing role: "tool" messages
  // directly (which gpt-5.x's API path rejects with "Unsupported role: tool").
  // Functionally equivalent: phase 2 sees the same tool-result data, just
  // packaged into one user-role payload.
  const phase1Trace = serializePhase1Trace(
    phase1 as unknown as { steps: ReadonlyArray<Phase2Step> }
  );
  let phase2;
  try {
    phase2 = await generateText({
      model: finbotModel(),
      system: RESPONSE_SYSTEM_PROMPT,
      messages: [
        ...messages,
        {
          role: "user",
          content: `[ENGINE TRACE — these are the tool calls and results from the previous step. Use them to populate the respond/decline arguments.]\n\n${phase1Trace}`,
        },
      ],
      tools: responseTools,
      toolChoice: "required",
      maxSteps: 1,
      temperature: 0.2,
    });
  } catch (err) {
    console.error("[finbot] phase 2 forced-respond failed:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Emit one combined data-stream: phase 1's tool calls (so the user sees
  // what was computed), then phase 2's respond/decline call (the structured
  // reply the renderer turns into the bubble).
  const body =
    encodePhaseTail(
      phase1 as unknown as { steps: ReadonlyArray<Phase2Step> },
      `msg-engine-${Date.now()}`
    ) +
    encodePhaseTail(
      phase2 as unknown as { steps: ReadonlyArray<Phase2Step> },
      `msg-respond-${Date.now()}`
    );

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "x-vercel-ai-data-stream": "v1",
    },
  });
}

interface Phase2Step {
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
}

/** Serialize phase 1's tool calls + results as a JSON appendix that phase 2
 *  reads as a user message. Avoids passing role: "tool" messages through
 *  OpenAI's Responses API path, which rejects them. */
function serializePhase1Trace(phase: { steps: ReadonlyArray<Phase2Step> }): string {
  const trace: Array<{ tool: string; args: unknown; result: unknown }> = [];
  for (const step of phase.steps) {
    const resultsById = new Map(step.toolResults.map((r) => [r.toolCallId, r.result]));
    for (const call of step.toolCalls) {
      trace.push({
        tool: call.toolName,
        args: call.args,
        result: resultsById.get(call.toolCallId) ?? null,
      });
    }
  }
  return JSON.stringify(trace, null, 2);
}

/** Encode a phase's tool calls + results as a chunk of the AI SDK data-stream
 *  protocol, ready to send to the client. Used for both phase 1 (engine
 *  tools) and phase 2 (respond/decline) so they render as a single assistant
 *  turn on the client. */
function encodePhaseTail(
  phase: { steps: ReadonlyArray<Phase2Step> },
  messageId: string
): string {
  const lines: string[] = [];
  lines.push(`f:${JSON.stringify({ messageId })}\n`);
  for (const step of phase.steps) {
    for (const call of step.toolCalls) {
      lines.push(
        `9:${JSON.stringify({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
        })}\n`
      );
    }
    for (const result of step.toolResults) {
      lines.push(
        `a:${JSON.stringify({
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          result: result.result,
        })}\n`
      );
    }
  }
  lines.push(
    `e:${JSON.stringify({ finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 }, isContinued: false })}\n`
  );
  lines.push(
    `d:${JSON.stringify({ finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } })}\n`
  );
  return lines.join("");
}
