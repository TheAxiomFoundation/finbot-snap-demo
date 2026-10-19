/**
 * Single source of truth for which OpenAI model the chat layer uses.
 *
 * Defaults to gpt-6-luna at the model's own default settings — the model a
 * free ChatGPT user gets — so the side-by-side compares Axiom against the
 * plain model people actually meet, with no tuned reasoning or sampling.
 * Override with FINBOT_MODEL (e.g. gpt-5.5, gpt-6.1-sol).
 *
 * Same model is used for the FinBot chat and BOTH sides of the Side-by-side
 * comparison so the comparison stays fair (raw vs raw + axiom tools).
 */
import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";

// `||`, not `??`: .env.example ships `FINBOT_MODEL=`, and an empty value
// must fall back too (it would otherwise break API calls and render "runs on
// OpenAI's ." in the session notice).
export const FINBOT_MODEL_NAME = process.env.FINBOT_MODEL?.trim() || "gpt-6-luna";

/** Optional reasoning-effort override (FINBOT_REASONING=low|medium|high).
 *  Unset → null, which the provider treats as absent: the model's own
 *  default. (null rather than undefined because providerOptions values must
 *  be JSON.) Routes pass it via providerOptions; @ai-sdk/openai 1.3 only
 *  forwards it for ids it recognizes as reasoning models ("o*", "gpt-5*"),
 *  so it has no effect on gpt-6 ids. */
export const REASONING_EFFORT = (process.env.FINBOT_REASONING ?? null) as "low" | "medium" | "high" | null;

/** ai 4.3 sends temperature 0 when a call sets none, and @ai-sdk/openai 1.3
 *  strips it only for "o*"/"gpt-5*" ids; gpt-6 models reject the parameter
 *  outright. Every model this app runs is a reasoning model that ignores
 *  sampling settings (the gpt-5 family already dropped the routes' 0.2), so
 *  drop temperature for all of them. All models route through the Responses
 *  API, which is the only one serving tools + reasoning for these models. */
export const finbotModel = () =>
  wrapLanguageModel({
    model: openai.responses(FINBOT_MODEL_NAME),
    middleware: {
      transformParams: async ({ params }) => ({ ...params, temperature: undefined }),
    },
  });
