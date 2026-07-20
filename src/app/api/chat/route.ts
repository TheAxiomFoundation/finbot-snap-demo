import { streamText, type CoreMessage } from "ai";

import { FINBOT_MODEL_NAME, finbotModel, REASONING_EFFORT } from "@/lib/model";
import { buildSystemPrompt } from "@/lib/prompts";
import { tools } from "@/lib/tools";

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
  const body = (await req.json()) as { messages: CoreMessage[] };
  const { messages } = body;

  // Per-step latency attribution: each step = one LLM round-trip (generation
  // of text and/or tool calls) plus the tool executions inside it. Tool
  // execution time is logged separately by the `timed` wrapper in tools.ts —
  // the delta between the two is model time.
  const requestStart = Date.now();
  let lastStepEnd = requestStart;
  let stepIndex = 0;

  const result = streamText({
    model: finbotModel(),
    system: buildSystemPrompt(),
    messages,
    tools,
    maxSteps: 12,
    temperature: 0.2,
    // Stream tool-call deltas so the client's activity trail can show the
    // next step while the model is still writing its arguments, instead of
    // only when the call is complete.
    toolCallStreaming: true,
    // The OpenAI Responses API (gpt-5.5-pro etc.) requires strict tool
    // schemas by default — every property must be marked required, which
    // breaks our zod .optional() fact fields. Disable strictSchemas to keep
    // the same surface working on both the chat-completions and Responses
    // adapters. No-op on chat-completions models.
    providerOptions: { openai: { strictSchemas: false, reasoningEffort: REASONING_EFFORT } },
    onError({ error }) {
      console.error("[finbot] streamText error:", error);
    },
    onStepFinish(step) {
      const now = Date.now();
      const calls = step.toolCalls.map((c) => c.toolName).join("+") || "text";
      console.log(
        `[finbot:timing] step ${++stepIndex} ${calls} ${now - lastStepEnd}ms (total ${now - requestStart}ms, prompt ${step.usage.promptTokens}tok, completion ${step.usage.completionTokens}tok)`
      );
      lastStepEnd = now;
    },
  });

  return result.toDataStreamResponse({
    headers: { "x-finbot-model": FINBOT_MODEL_NAME },
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
