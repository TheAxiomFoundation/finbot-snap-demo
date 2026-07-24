/** Static UI copy and the raw-LLM compare-mode prompt. US-only. */

export const INPUT_PLACEHOLDER =
  "Ask about SNAP, TANF, or income tax anywhere Axiom has certified rules...";

export const RAW_SYSTEM = `You are a US benefits and tax assistant. Answer the user's question as helpfully as you can. Use plain language and round dollars. You have no calculation tools, so be clear that any figures are approximate and ask for missing facts rather than inventing them.`;

export const PAGE_METADATA = {
  title: "Chatbot — Axiom-grounded benefits assistant",
  description:
    "OpenAI on top of the Axiom rules engine. Benefit and tax calculations for every program certified in rulespec-us, with citations.",
  alternates: { canonical: "https://axiom.org/chatbot" },
};
