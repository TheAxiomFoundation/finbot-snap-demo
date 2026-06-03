/**
 * Single source of truth for which OpenAI model the chat layer uses.
 *
 * Defaults to gpt-5.5 — the current standard-tier release (2026-04-22),
 * strong on the tool-sequencing patterns this app needs (compute_*_snap,
 * compute_uk_*, Colorado ranking, correct primary-output field selection).
 *
 * Override per environment with the FINBOT_MODEL env var. Same model is used
 * for the FinBot chat and BOTH sides of the Side-by-side comparison so the
 * comparison stays fair (raw vs raw + axiom tools).
 */
import { openai } from "@ai-sdk/openai";

export const FINBOT_MODEL_NAME = process.env.FINBOT_MODEL ?? "gpt-5.5";

/** GPT-5 family enforces strict tool schemas by default — every property in
 *  a tool's parameters must be in `required`, which conflicts with our
 *  zod `.optional()` fields (e.g. the `search` arg on list_encoded_outputs).
 *  Setting `structuredOutputs: false` keeps the model in non-strict tool mode
 *  so optional fields work the way they always have. */
export const finbotModel = () =>
  openai(FINBOT_MODEL_NAME, { structuredOutputs: false });
