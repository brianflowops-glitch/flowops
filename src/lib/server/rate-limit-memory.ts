/**
 * Per-instance in-memory fixed-window limiter. Used only as the fallback when the Postgres limiter errors,
 * so a database outage degrades protection (per serverless instance) instead of removing it. Pure; unit-tested.
 */
const MAX_KEYS = 10_000;

export class MemoryRateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  check(key: string, max: number, windowSec: number, now = Date.now()): { ok: boolean; retryAfter: number } {
    const winMs = windowSec * 1000;
    let w = this.windows.get(key);
    if (!w || now - w.start >= winMs) {
      w = { start: now, count: 0 };
      this.windows.delete(key); // re-insert to keep Map order ≈ recency for pruning
      this.windows.set(key, w);
      this.prune(now);
    }
    w.count++;
    return { ok: w.count <= max, retryAfter: Math.max(1, Math.ceil((w.start + winMs - now) / 1000)) };
  }

  private prune(now: number) {
    if (this.windows.size <= MAX_KEYS) return;
    for (const [k, w] of this.windows) {
      if (this.windows.size <= MAX_KEYS * 0.9) break;
      if (now - w.start > 3_600_000 || this.windows.size > MAX_KEYS) this.windows.delete(k);
    }
  }

  get size() {
    return this.windows.size;
  }
}
