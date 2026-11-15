/**
 * Fixed-window rate limiter keyed by client (e.g. IP address). In-memory only,
 * which is enough for a single-instance demo deployment.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Record one request for `key`; returns false when it exceeds the limit. */
  allow(key: string, nowMs = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || nowMs - entry.windowStart >= this.windowMs) {
      // Drop expired entries now and then so the map can't grow without bound.
      if (this.hits.size > 10_000) this.prune(nowMs);
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private prune(nowMs: number): void {
    for (const [key, e] of this.hits) {
      if (nowMs - e.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
