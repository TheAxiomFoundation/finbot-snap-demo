/**
 * Engine adapter — TypeScript wrapper around the axiom-rules Rust binary.
 *
 * Spawns `axiom-rules run-compiled` per request, writes a JSON request to stdin,
 * parses the JSON response from stdout. The compiled artifact is loaded fresh
 * each call; that costs ~80–150ms but keeps the surface trivial.
 *
 * The engine speaks legal-ID inputs (e.g. `us:statutes/7/2017/a#input.household_size`).
 * Callers in lib/programs/* assemble those payloads from a small typed
 * "user-facing facts" object so the chat layer never has to know legal IDs.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const BINARY =
  process.env.AXIOM_RULES_BINARY ||
  path.join(ROOT, "engine/axiom-rules/target/release/axiom-rules");
const ARTIFACTS_DIR =
  process.env.AXIOM_ARTIFACTS_DIR || path.join(ROOT, "engine/artifacts");

export type FactScalar = boolean | number | string;

export type FactValue =
  | { kind: "bool"; value: boolean }
  | { kind: "integer"; value: number }
  | { kind: "decimal"; value: string }
  | { kind: "text"; value: string }
  | { kind: "date"; value: string };

export interface Interval {
  start: string; // YYYY-MM-DD
  end: string;
}

export interface InputRecord {
  name: string; // legal ID
  entity: "Household" | "Person" | string;
  entity_id: string;
  interval: Interval;
  value: FactValue;
}

export interface RelationRecord {
  name: string;
  tuple: [string, string]; // [person, household] for member_of_household
  interval: Interval;
}

export interface QueryRequest {
  entity_id: string;
  period: { period_kind: "month" | "year"; start: string; end: string };
  outputs: string[]; // legal IDs
}

export interface ExecutionRequest {
  mode: "fast" | "explain";
  dataset: { inputs: InputRecord[]; relations: RelationRecord[] };
  queries: QueryRequest[];
}

type Outcome = "holds" | "not_holds";

export type OutputValue =
  | { kind: "scalar"; name: string; id: string; dtype: string; unit?: string | null; value: { kind: string; value: string | number | boolean } }
  | { kind: "judgment"; name: string; id: string; unit?: string | null; outcome: Outcome };

export interface ExecutionResponse {
  metadata: { requested_mode: string; actual_mode: string; fallback_reason: string | null };
  results: Array<{
    entity_id: string;
    period: { period_kind: string; start: string; end: string };
    outputs: Record<string, OutputValue>;
    trace?: Record<string, unknown>;
  }>;
}

/** Coerce a JS scalar into the discriminated FactValue the engine expects.
 *  When the slot's expected dtype is known, prefer the typed variant to avoid
 *  bulk-if branch mismatches; otherwise pick by JS type. */
export function fact(value: FactScalar, dtype?: "bool" | "integer" | "decimal" | "date" | "text"): FactValue {
  if (dtype === "bool") return { kind: "bool", value: Boolean(value) };
  if (dtype === "integer") return { kind: "integer", value: Math.round(Number(value)) };
  if (dtype === "decimal") return { kind: "decimal", value: String(Number(value)) };
  if (dtype === "date") return { kind: "date", value: String(value) };
  if (dtype === "text") return { kind: "text", value: String(value) };
  // No hint — pick by JS type.
  if (typeof value === "boolean") return { kind: "bool", value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { kind: "integer", value };
    return { kind: "decimal", value: String(value) };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "date", value };
  return { kind: "text", value };
}

/** Convert a record of {legal_id: scalar} into InputRecord[] for one entity. */
export function recordsForEntity(
  facts: Record<string, FactScalar>,
  entity: InputRecord["entity"],
  entity_id: string,
  interval: Interval
): InputRecord[] {
  return Object.entries(facts).map(([name, value]) => ({
    name,
    entity,
    entity_id,
    interval,
    value: fact(value),
  }));
}

/** Build a half-open monthly interval for "YYYY-MM". */
export function monthInterval(period: string): { interval: Interval; period: { period_kind: "month"; start: string; end: string } } {
  const [yStr, mStr] = period.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const start = `${period}-01`;
  const endY = m === 12 ? y + 1 : y;
  const endM = m === 12 ? 1 : m + 1;
  const end = `${endY.toString().padStart(4, "0")}-${endM.toString().padStart(2, "0")}-01`;
  return { interval: { start, end }, period: { period_kind: "month", start, end } };
}

/** Where to send compute requests when running in production (Vercel).
 *  Points at the Modal-hosted axiom-engine service; see modal_app.py. When
 *  unset, the runtime falls back to spawning the binary locally — that's the
 *  development path on a machine where `bun run engine:setup` has run. */
const ENGINE_URL = process.env.AXIOM_ENGINE_URL?.replace(/\/$/, "");

let cachedBinaryOk: boolean | null = null;

async function ensureBinary(): Promise<void> {
  if (cachedBinaryOk) return;
  try {
    await fs.access(BINARY, fs.constants.X_OK);
    cachedBinaryOk = true;
  } catch {
    cachedBinaryOk = false;
    throw new Error(
      `axiom-rules binary not found at ${BINARY}. Run \`bun run engine:setup\` first, or set AXIOM_ENGINE_URL to a deployed engine.`
    );
  }
}

async function artifactPath(slug: string): Promise<string> {
  const p = path.join(ARTIFACTS_DIR, `${slug}.compiled.json`);
  try {
    await fs.access(p, fs.constants.R_OK);
    return p;
  } catch {
    throw new Error(`compiled artifact not found: ${p}. Run \`bun run engine:build\`.`);
  }
}

/** Run a compiled artifact against a built request. Throws on engine error.
 *
 *  Two transports, picked by env:
 *    - `AXIOM_ENGINE_URL` set → POST to {url}/run (production path).
 *    - unset → spawn the local binary against the local artifact (dev path).
 *
 *  Both transports share the same request/response shape so callers don't
 *  care which is in use.
 */
export async function runCompiled(
  slug: string,
  request: ExecutionRequest
): Promise<ExecutionResponse> {
  if (ENGINE_URL) return runViaHttp(slug, request);
  return runViaSubprocess(slug, request);
}

async function runViaHttp(slug: string, request: ExecutionRequest): Promise<ExecutionResponse> {
  const r = await fetch(`${ENGINE_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ program: slug, request }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`axiom-engine ${r.status}: ${body.slice(0, 500)}`);
  }
  return (await r.json()) as ExecutionResponse;
}

async function runViaSubprocess(
  slug: string,
  request: ExecutionRequest
): Promise<ExecutionResponse> {
  await ensureBinary();
  const artifact = await artifactPath(slug);
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, ["run-compiled", "--artifact", artifact], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`axiom-rules exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`could not parse engine output: ${(err as Error).message}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Pull a clean numeric/judgment value out of an OutputValue. */
export function readOutput(out: OutputValue): {
  kind: "scalar" | "judgment";
  numeric?: number;
  outcome?: Outcome;
} {
  if (out.kind === "judgment") return { kind: "judgment", outcome: out.outcome };
  const v = out.value.value;
  const n = typeof v === "number" ? v : Number(v);
  return { kind: "scalar", numeric: Number.isFinite(n) ? n : undefined };
}
