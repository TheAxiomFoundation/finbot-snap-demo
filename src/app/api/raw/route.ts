/**
 * Plain-LLM endpoint — same model the chat uses, no tools, no axiom
 * grounding. Used by the side-by-side compare-mode in Chat.tsx so each
 * assistant turn can show what the model alone would have said next to
 * the axiom-grounded answer.
 */
import { generateText, type CoreMessage } from "ai";

import { RAW_SYSTEM } from "@/lib/copy";
import { finbotModel, REASONING_EFFORT } from "@/lib/model";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const limited = enforceRateLimit(req);
  if (limited) return limited;
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set on the server." }, { status: 500 });
  }
  const body = (await req.json()) as { messages: CoreMessage[] };
  const { messages } = body;
  try {
    const r = await generateText({
      model: finbotModel(),
      system: RAW_SYSTEM,
      messages,
      temperature: 0.2,
      providerOptions: { openai: { reasoningEffort: REASONING_EFFORT } },
    });
    return Response.json({ text: r.text });
  } catch (err) {
    console.error("[finbot] /api/raw failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
