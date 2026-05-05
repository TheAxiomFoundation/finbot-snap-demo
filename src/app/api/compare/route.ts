/**
 * Comparison endpoint: same prompt run twice, side-by-side.
 * - "raw": same model with no tools and no axiom context. Whatever it knows.
 * - "axiom": two-phase axiom flow (engine tools, then forced respond/decline).
 *
 * The axiom side mirrors /api/chat's two-phase shape so anything we improve in
 * the chat surface — better tool prompts, the persistence rules, the harness-
 * owned response format — applies here too.
 */
import { generateText, type CoreMessage } from "ai";

import { FINBOT_MODEL_NAME, finbotModel } from "@/lib/model";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { tools } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 120;

interface CompareRequest {
  prompt: string;
}

const RAW_SYSTEM = `You are a benefits assistant. Answer the user's question as helpfully as you can. Use plain language and round dollars.`;

const RESPONSE_SYSTEM_PROMPT = `You are FinBot. The previous turn ran any engine tools needed; now you produce the user-facing response.

You MUST call exactly one of:
- \`respond\` — the normal benefits answer.
- \`decline_out_of_scope\` — for non-encoded programs or non-benefits topics.

For \`respond\`, pick a \`kind\` and the harness builds the headline from your tool results:
- \`kind: "household_benefit"\` when compute_co_snap ran (harness reads snap_regular_month_allotment + snap_eligible). Use this for not-eligible cases too; the harness builds the "Not eligible — the X test failed" headline from the failing sub-judgment. Don't fall back to free_form for denials.
- \`kind: "parameter_value"\` when lookup_value ran (harness reads the value). Pass \`parameter_label\` for context.
- \`kind: "free_form"\` only when neither applies; then pass \`custom_headline\`.

what_could_change lists FACTS about the user's situation, never system capabilities. Closing offers go in action. Don't editorialize.`;

const { respond, decline_out_of_scope, ...engineTools } = tools;
const responseTools = { respond, decline_out_of_scope };

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not set on the server." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  const { prompt } = (await req.json()) as CompareRequest;
  if (!prompt) {
    return new Response(JSON.stringify({ error: "missing prompt" }), { status: 400 });
  }

  const userMessage: CoreMessage = { role: "user", content: prompt };

  const [raw, axiom] = await Promise.allSettled([
    generateText({
      model: finbotModel(),
      system: RAW_SYSTEM,
      prompt,
      temperature: 0.2,
    }),
    runAxiomPipeline(userMessage),
  ]);

  const axiomBody = axiom.status === "fulfilled"
    ? { invocations: axiom.value.invocations }
    : { error: String(axiom.reason) };

  const result = {
    model: FINBOT_MODEL_NAME,
    raw: raw.status === "fulfilled" ? { text: raw.value.text } : { error: String(raw.reason) },
    axiom: axiomBody,
  };

  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
}

interface CompareInvocation {
  tool_call_id: string;
  name: string;
  args: unknown;
  result: unknown;
}

/** Two-phase axiom pipeline matching /api/chat's shape. Returns the flat list
 *  of invocations (engine + respond/decline) the Compare UI consumes. */
async function runAxiomPipeline(
  userMessage: CoreMessage
): Promise<{ invocations: CompareInvocation[] }> {
  // Phase 1: engine pass.
  const phase1 = await generateText({
    model: finbotModel(),
    system: SYSTEM_PROMPT,
    messages: [userMessage],
    tools: engineTools,
    maxSteps: 6,
    temperature: 0.2,
  });

  // Phase 2: forced respond/decline.
  const phase2 = await generateText({
    model: finbotModel(),
    system: RESPONSE_SYSTEM_PROMPT,
    messages: [userMessage, ...phase1.response.messages],
    tools: responseTools,
    toolChoice: "required",
    maxSteps: 1,
    temperature: 0.2,
  });

  const invocations: CompareInvocation[] = [];
  for (const step of phase1.steps) {
    const resultsById = new Map(step.toolResults.map((r) => [r.toolCallId, r.result]));
    for (const c of step.toolCalls) {
      invocations.push({
        tool_call_id: c.toolCallId,
        name: c.toolName,
        args: c.args,
        result: resultsById.get(c.toolCallId) ?? null,
      });
    }
  }
  for (const step of phase2.steps) {
    const resultsById = new Map(step.toolResults.map((r) => [r.toolCallId, r.result]));
    for (const c of step.toolCalls) {
      invocations.push({
        tool_call_id: c.toolCallId,
        name: c.toolName,
        args: c.args,
        result: resultsById.get(c.toolCallId) ?? null,
      });
    }
  }
  return { invocations };
}
