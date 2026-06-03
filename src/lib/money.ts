/** Format a number as a whole-currency-unit string, e.g. "$2,570" or "£2,570".
 *  Handles USD and GBP; falls back to plain numeric for unknown currencies. */
export function formatMoney(n: number, currency: "USD" | "GBP" = "USD"): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n).toLocaleString();
  const symbol = currency === "GBP" ? "£" : "$";
  return `${symbol}${rounded}`;
}

import type { Country } from "./catalog";

export function currencyForCountry(country: Country): "USD" | "GBP" {
  return country === "uk" ? "GBP" : "USD";
}
