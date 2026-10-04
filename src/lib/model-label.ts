/**
 * Human-readable name for the chat model, for the AI disclosure. Kept apart
 * from model.ts so client components can import it without pulling in the
 * OpenAI adapter.
 *
 *   gpt-5.5      → GPT-5.5
 *   gpt-5.5-pro  → GPT-5.5 Pro
 *   gpt-5.5-mini → GPT-5.5 Mini
 *
 * Anything else (dated snapshots, other families) is shown verbatim: an
 * exact model id is always an accurate disclosure, a guessed brand name
 * might not be.
 */
export const MODEL_PROVIDER = "OpenAI";

export function modelDisplayName(modelId: string): string {
  const m = /^gpt-(\d+(?:\.\d+)*)(?:-(pro|mini|nano))?$/i.exec(modelId.trim());
  if (!m) return modelId.trim();
  const tier = m[2] ? ` ${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}` : "";
  return `GPT-${m[1]}${tier}`;
}
