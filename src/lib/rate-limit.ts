/**
 * Per-client sliding-window rate limiting for the model-calling routes.
 *
 * Both /api/chat and /api/raw spend real OpenAI tokens per request (and
 * compare mode fires both per user turn), on a public deployment with no
 * auth. This limiter is the abuse damper: it bounds how fast any one
 * client can burn tokens.
 *
 * State is in-memory, so on serverless it is per-instance: a determined
 * attacker spread across instances can exceed the nominal limit. That is
 * accepted — the goal is stopping runaway loops and casual scripting, not
 * hard quota enforcement (which would need shared state, e.g. KV).
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the oldest counted request leaves the window. */
  retryAfterSeconds: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW_SECONDS = 300;
/** Cap tracked clients so hostile IP churn cannot grow memory unbounded. */
const MAX_TRACKED_KEYS = 10_000;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const cutoff = now - this.windowMs;
    const seen = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (seen.length >= this.limit) {
      this.hits.set(key, seen);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((seen[0] + this.windowMs - now) / 1000)
        ),
      };
    }
    seen.push(now);
    this.hits.set(key, seen);
    if (this.hits.size > MAX_TRACKED_KEYS) {
      this.evictStale(cutoff);
    }
    return {
      allowed: true,
      remaining: this.limit - seen.length,
      retryAfterSeconds: 0,
    };
  }

  private evictStale(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) {
        this.hits.delete(key);
      }
    }
    // Pathological case: every key is live. Drop oldest-inserted entries
    // rather than growing without bound.
    if (this.hits.size > MAX_TRACKED_KEYS) {
      for (const key of this.hits.keys()) {
        if (this.hits.size <= MAX_TRACKED_KEYS) break;
        this.hits.delete(key);
      }
    }
  }
}

function configuredLimiter(): SlidingWindowLimiter {
  const limit = Number(process.env.FINBOT_RATE_LIMIT) || DEFAULT_LIMIT;
  const windowSeconds =
    Number(process.env.FINBOT_RATE_WINDOW_SECONDS) || DEFAULT_WINDOW_SECONDS;
  return new SlidingWindowLimiter(limit, windowSeconds * 1000);
}

// Module-level singleton: shared across requests within one instance.
let limiter: SlidingWindowLimiter | undefined;

export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Returns a 429 response when the client is over budget, else null.
 * Call at the top of any route that spends model tokens.
 */
export function enforceRateLimit(req: Request): Response | null {
  limiter ??= configuredLimiter();
  const decision = limiter.check(clientKey(req));
  if (decision.allowed) return null;
  return Response.json(
    {
      error:
        "Rate limit reached — this demo allows a limited number of " +
        "requests per client. Please wait a moment and try again.",
    },
    {
      status: 429,
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
    }
  );
}
