/**
 * Single source of truth for which OpenAI model the chat layer uses.
 *
 * Defaults to gpt-5.5 — the current standard-tier release (2026-04-22),
 * strong on the tool-sequencing patterns this app needs (describe-before-
 * compute, correct primary-output field selection).
 * Pro tier works but takes ~10x longer per turn; set FINBOT_MODEL=gpt-5.5-pro
 * to opt in (finbotModel() routes pro through the Responses API).
 *
 * Same model is used for the FinBot chat and BOTH sides of the Side-by-side
 * comparison so the comparison stays fair (raw vs raw + axiom tools).
 */
import { openai } from "@ai-sdk/openai";

export const FINBOT_MODEL_NAME = process.env.FINBOT_MODEL ?? "gpt-5.5";

/** GPT-5 family enforces strict tool schemas by default — every property in
 *  a tool's parameters must be in `required`, which conflicts with our
 *  zod `.optional()` fields (e.g. the `search` arg on list_encoded_outputs).
 *  Setting `structuredOutputs: false` keeps the model in non-strict tool mode
 *  so optional fields work the way they always have.
 *
 *  Pro-tier models (gpt-5.5-pro and friends) aren't served on
 *  /v1/chat/completions — they require the Responses API. Switch adapter
 *  based on the model name so the env var can flip between tiers without
 *  touching this file. */
/** Reasoning-effort dial for the gpt-5 family. Latency tracing showed model
 *  thinking gaps of 7-9s per step at the default effort while engine work is
 *  ~50ms/turn — "low" cuts those gaps substantially. Raise via env if answer
 *  quality regresses (verify with `bun run eval:llm`).
 *
 *  gpt-5.5 only supports tools + reasoning_effort on the Responses API, so
 *  all gpt-5 models route through openai.responses(); the effort itself is
 *  passed via providerOptions in the routes (see api/chat, api/raw). */
export const REASONING_EFFORT = (process.env.FINBOT_REASONING ?? "low") as "low" | "medium" | "high";

export const finbotModel = () => {
  return openai.responses(FINBOT_MODEL_NAME);
};
