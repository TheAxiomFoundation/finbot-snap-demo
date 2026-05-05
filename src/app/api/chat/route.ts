import { openai } from "@ai-sdk/openai";
import { streamText, type CoreMessage } from "ai";

import { SYSTEM_PROMPT } from "@/lib/prompts";
import { tools } from "@/lib/tools";

export const runtime = "nodejs"; // we need child_process to spawn axiom-rules
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not set on the server. Add it to .env.local and restart." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  const { messages } = (await req.json()) as { messages: CoreMessage[] };

  const result = streamText({
    model: openai("gpt-4o"),
    system: SYSTEM_PROMPT,
    messages,
    tools,
    maxSteps: 6,
    temperature: 0.2,
    onError({ error }) {
      console.error("[finbot] streamText error:", error);
    },
  });

  return result.toDataStreamResponse({
    // Surface the actual reason instead of the SDK's "An error occurred" default.
    getErrorMessage(error) {
      if (error instanceof Error) return `${error.name}: ${error.message}`;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    },
  });
}
