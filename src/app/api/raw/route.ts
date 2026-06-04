/**
 * Plain-LLM endpoint — same model the chat uses, no tools, no axiom
 * grounding. Used by the side-by-side compare-mode in Chat.tsx so each
 * assistant turn can show what the model alone would have said next to
 * the axiom-grounded answer.
 */
import { generateText, type CoreMessage } from "ai";

import { finbotModel } from "@/lib/model";

export const runtime = "nodejs";
export const maxDuration = 300;

const RAW_SYSTEM = `You are a benefits assistant. Answer the user's question as helpfully as you can. Use plain language and round dollars.`;

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set on the server." }, { status: 500 });
  }
  const { messages } = (await req.json()) as { messages: CoreMessage[] };
  try {
    const r = await generateText({
      model: finbotModel(),
      system: RAW_SYSTEM,
      messages,
      temperature: 0.2,
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
