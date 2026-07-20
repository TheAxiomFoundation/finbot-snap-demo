/** Format a number with its unit, e.g. "$2,570" for USD; plain numeric for
 *  unitless or unknown-unit values. */
export function formatValue(n: number, unit?: string | null): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n).toLocaleString();
  if (unit === "USD") return `$${rounded}`;
  if (!unit) return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
  return `${rounded} ${unit}`;
}
