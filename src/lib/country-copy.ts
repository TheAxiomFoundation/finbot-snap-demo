import type { Country } from "./catalog";

export function normalizeCountry(country: unknown): Country {
  return country === "uk" ? "uk" : "us";
}

export function countryFromRequestBody(body: { country?: unknown }): Country {
  return normalizeCountry(body.country);
}

export function countryFromSearchParams(params?: {
  country?: string | string[];
}): Country {
  const country = Array.isArray(params?.country)
    ? params?.country[0]
    : params?.country;
  return normalizeCountry(country);
}

export function inputPlaceholderForCountry(country: Country): string {
  return country === "uk"
    ? "Ask about Universal Credit or your UK personal allowance..."
    : "Ask about SNAP eligibility or amount in CO, CA, or NY...";
}

export const RAW_SYSTEM_US = `You are a US benefits assistant. Answer the user's question as helpfully as you can. Use plain language and round dollars. Default to US benefit programs only when the user has not selected another country.`;

export const RAW_SYSTEM_UK = `You are a UK tax-and-benefits assistant. The user is using the UK side of FinBot, so answer in UK context unless they explicitly ask about another country.

Use UK programmes, UK terminology, and £/GBP. Do not answer with US benefits or US services such as SNAP/Food Stamps, Medicaid/CHIP, TANF, WIC, Unemployment Insurance, Benefits.gov, 211, or state benefit offices unless the user explicitly asks for a US comparison.

This plain-AI side has no Axiom rules-engine tools, so be clear that any figures are approximate and ask for missing facts rather than inventing them.`;

export function rawSystemPromptForCountry(country: Country): string {
  return country === "uk" ? RAW_SYSTEM_UK : RAW_SYSTEM_US;
}

export function metadataForCountry(country: Country) {
  return country === "uk"
    ? {
        title: "FinBot UK — Axiom-grounded tax and benefits assistant",
        description:
          "OpenAI on top of the Axiom rules engine. UK personal allowance and Universal Credit calculations with citations.",
      }
    : {
        title: "FinBot — Axiom-grounded benefits assistant",
        description:
          "OpenAI on top of the Axiom rules engine. SNAP calculations for Colorado, California, and New York, with citations.",
      };
}
