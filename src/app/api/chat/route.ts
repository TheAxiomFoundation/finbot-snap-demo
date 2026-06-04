import { streamText, type CoreMessage } from "ai";

import type { Country } from "@/lib/catalog";
import { countryFromRequestBody } from "@/lib/country-copy";
import { finbotModel } from "@/lib/model";
import { systemPromptForCountry } from "@/lib/prompts";
import { toolsForCountry } from "@/lib/tools";

export const runtime = "nodejs"; // we need child_process to spawn axiom-rules-engine
// 300s ceiling so the Pro-tier reasoning models (gpt-5.5-pro, etc.) can
// finish multi-tool turns without being cut off mid-stream.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not set on the server. Add it to .env.local and restart." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  const body = (await req.json()) as { messages: CoreMessage[]; country?: Country };
  const country = countryFromRequestBody(body);
  const { messages } = body;

  const result = streamText({
    model: finbotModel(),
    system: systemPromptForCountry(country),
    messages,
    tools: toolsForCountry(country),
    maxSteps: 6,
    temperature: 0.2,
    // The OpenAI Responses API (gpt-5.5-pro etc.) requires strict tool
    // schemas by default — every property must be marked required, which
    // breaks our zod .optional() fact fields. Disable strictSchemas to keep
    // the same surface working on both the chat-completions and Responses
    // adapters. No-op on chat-completions models.
    providerOptions: { openai: { strictSchemas: false } },
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
