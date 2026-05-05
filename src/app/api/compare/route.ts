/**
 * Comparison endpoint: same prompt run twice, side-by-side.
 * - "raw": OpenAI with no tools, no axiom context. Whatever the model knows.
 * - "axiom": OpenAI with axiom tools enabled. Uses real RuleSpec computations.
 */
import { generateText } from "ai";

import { FINBOT_MODEL_NAME, finbotModel } from "@/lib/model";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { tools } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 90;

interface CompareRequest {
  prompt: string;
}

const RAW_SYSTEM = `You are a benefits assistant. Answer the user's question as helpfully as you can. Use plain language and round dollars.`;

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

  const [raw, axiom] = await Promise.allSettled([
    generateText({
      model: finbotModel(),
      system: RAW_SYSTEM,
      prompt,
      temperature: 0.2,
    }),
    generateText({
      model: finbotModel(),
      system: SYSTEM_PROMPT,
      prompt,
      tools,
      maxSteps: 6,
      temperature: 0.2,
    }),
  ]);

  // Pair each tool call with its result by toolCallId, in temporal order, so
  // the UI can render call+result side-by-side instead of two parallel lists.
  const axiomInvocations = axiom.status === "fulfilled"
    ? axiom.value.steps.flatMap((s) => {
        const resultsById = new Map(s.toolResults.map((r) => [r.toolCallId, r.result]));
        return s.toolCalls.map((c) => ({
          tool_call_id: c.toolCallId,
          name: c.toolName,
          args: c.args,
          result: resultsById.get(c.toolCallId) ?? null,
        }));
      })
    : [];

  const result = {
    model: FINBOT_MODEL_NAME,
    raw: raw.status === "fulfilled" ? { text: raw.value.text } : { error: String(raw.reason) },
    axiom:
      axiom.status === "fulfilled"
        ? { text: axiom.value.text, invocations: axiomInvocations }
        : { error: String(axiom.reason) },
  };

  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
}
