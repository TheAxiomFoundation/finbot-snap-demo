import { describe, expect, it } from "vitest";

import { SlidingWindowLimiter, clientKey } from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit inside one window", () => {
    const limiter = new SlidingWindowLimiter(3, 1000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 100).allowed).toBe(true);
    expect(limiter.check("a", 200).allowed).toBe(true);
    const blocked = limiter.check("a", 300);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("frees capacity when hits leave the window", () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 500).allowed).toBe(true);
    expect(limiter.check("a", 900).allowed).toBe(false);
    expect(limiter.check("a", 1200).allowed).toBe(true);
  });

  it("tracks clients independently", () => {
    const limiter = new SlidingWindowLimiter(1, 1000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
    expect(limiter.check("a", 1).allowed).toBe(false);
  });

  it("reports retry-after from the oldest counted hit", () => {
    const limiter = new SlidingWindowLimiter(1, 10_000);
    limiter.check("a", 0);
    const blocked = limiter.check("a", 4000);
    expect(blocked.retryAfterSeconds).toBe(6);
  });

  it("blocked requests do not consume capacity", () => {
    const limiter = new SlidingWindowLimiter(1, 1000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 500).allowed).toBe(false);
    // The blocked attempt at t=500 must not extend the block past the
    // original hit's window.
    expect(limiter.check("a", 1100).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("uses the first x-forwarded-for hop", () => {
    const req = new Request("http://localhost/api/chat", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientKey(req)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip then unknown", () => {
    const withRealIp = new Request("http://localhost/api/chat", {
      headers: { "x-real-ip": "198.51.100.2" },
    });
    expect(clientKey(withRealIp)).toBe("198.51.100.2");
    expect(clientKey(new Request("http://localhost/api/chat"))).toBe(
      "unknown"
    );
  });
});
