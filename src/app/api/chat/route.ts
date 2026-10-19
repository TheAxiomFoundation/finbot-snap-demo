import { NoSuchToolError, createDataStreamResponse, generateObject, jsonSchema, streamText, type CoreMessage } from "ai";

import { checkGrounding } from "@/lib/grounding";
import { FINBOT_MODEL_NAME, finbotModel, REASONING_EFFORT } from "@/lib/model";
import { prefetchSection } from "@/lib/prefetch";
import { buildSystemPrompt } from "@/lib/prompts";
import { createTools } from "@/lib/tools";

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

  // Server-side describe pre-fetch: appended AFTER the static prompt so the
  // cacheable prefix stays byte-identical across requests. Detection runs
  // over every user message so the section stays stable on follow-up turns.
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((part) => ("text" in part ? part.text : "")).join(" ")
    )
    .join("\n");
  const prefetch = prefetchSection(userText);
  if (prefetch) {
    const slugs = [...prefetch.matchAll(/^### (\S+)/gm)].map((m) => m[1]);
    console.log(`[finbot:prefetch] injected ${slugs.join(", ")}`);
  }

  // Per-step latency attribution: each step = one LLM round-trip (generation
  // of text and/or tool calls) plus the tool executions inside it. Tool
  // execution time is logged separately by the `timed` wrapper in tools.ts —
  // the delta between the two is model time.
  const requestStart = Date.now();
  let lastStepEnd = requestStart;
  let stepIndex = 0;

  return createDataStreamResponse({
    headers: { "x-finbot-model": FINBOT_MODEL_NAME },
    // Surface the actual reason instead of the SDK's "An error occurred" default.
    onError(error) {
      if (error instanceof Error) return `${error.name}: ${error.message}`;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    },
    execute(dataStream) {
      // Phase 0: the engine's explain-mode trace already carries exact rule
      // provenance for every compute/lookup_value (see request-builder.ts).
      // It's 20–50 KB raw — too big for the model's context and not what the
      // model needs — so it never enters a tool result. It rides here instead,
      // as a stream annotation the client can render as a derivation panel.
      const tools = createTools((event) => {
        // ProvenanceAnnotation's nested types (RuleProvenance, Stamps, ...)
        // are plain JSON shapes but aren't declared with the AI SDK's
        // recursive JSONValue index signature; round-tripping through
        // JSON satisfies it without weakening those types elsewhere.
        dataStream.writeMessageAnnotation(JSON.parse(JSON.stringify(event)));
      });

      const result = streamText({
        model: finbotModel(),
        system: prefetch ? `${buildSystemPrompt()}\n\n${prefetch}` : buildSystemPrompt(),
        messages,
        // A stalled upstream stream has been observed hanging for 9+ minutes in
        // dev; fail fast (under the 300s maxDuration) instead of wedging the UI.
        abortSignal: AbortSignal.timeout(280_000),
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
        // A malformed tool call (invalid JSON args, schema mismatch) used to kill
        // the whole run and stream the raw fragment into the UI. Re-derive the
        // arguments once against the tool's schema instead. A hallucinated tool
        // NAME cannot be repaired into a valid call — returning null rethrows the
        // original error, which stays the (rare) hard-failure case. A failed
        // repair also returns null so the original, smaller error surfaces
        // instead of a ToolCallRepairError.
        experimental_repairToolCall: async ({ toolCall, parameterSchema, error }) => {
          if (NoSuchToolError.isInstance(error)) return null;
          console.warn(`[finbot:tool-repair] ${toolCall.toolName}: ${error.message}`);
          try {
            const { object: repairedArgs } = await generateObject({
              model: finbotModel(),
              // The SDK hands us the JSON schema directly; it also transmits it
              // to the provider, so the prompt doesn't need to repeat it.
              schema: jsonSchema<Record<string, unknown>>(parameterSchema(toolCall)),
              // Keep the repair inside the route's fail-fast envelope — without
              // its own signal a stalled repair round-trip rides to the 300s
              // platform kill.
              abortSignal: AbortSignal.timeout(60_000),
              providerOptions: { openai: { strictSchemas: false, reasoningEffort: REASONING_EFFORT } },
              prompt: [
                `A call to the tool "${toolCall.toolName}" carried invalid arguments:`,
                toolCall.args,
                `Validation error: ${error.message}`,
                "Emit the corrected arguments, preserving the caller's evident intent. Do not invent facts that are not present in the original arguments.",
              ].join("\n"),
            });
            console.log(`[finbot:tool-repair] ${toolCall.toolName} repaired`);
            return { ...toolCall, args: JSON.stringify(repairedArgs) };
          } catch (repairError) {
            console.error(`[finbot:tool-repair] ${toolCall.toolName} repair failed:`, repairError);
            return null;
          }
        },
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
        // Phase 0 runtime claim verifier — the eval harness's `grounded`
        // predicate (every dollar figure traces to a tool result or the
        // user's own prompt), ported to run on every real response instead
        // of only in the offline eval. Non-blocking: this reply already
        // streamed, so a failure here can only log/annotate, not withhold it.
        // Promoting it to a blocking repair loop is a Phase-3-era decision
        // (open question §9.2 in docs/answer-architecture.md), not this one.
        onFinish({ text, steps }) {
          const toolResults = steps.flatMap((step) => step.toolResults.map((r) => r.result));
          const { invented, grounded } = checkGrounding(text, toolResults, userText);
          if (!grounded) {
            console.warn(`[finbot:grounding] ungrounded figures: ${invented.map((n) => `$${n}`).join(", ")}`);
          }
          dataStream.writeMessageAnnotation({
            type: "grounding",
            grounded,
            ...(invented.length > 0 && { invented }),
          });
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
  });
}
