import { createLogger } from "../logger";

const log = createLogger("middleware:idempotency");

/**
 * In-memory idempotency store for event deduplication.
 * Evicts entries older than TTL to prevent unbounded growth.
 */
class IdempotencyStore {
  private seen = new Map<string, number>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;

    // Periodic cleanup every minute
    setInterval(() => this.cleanup(), 60_000);
  }

  isDuplicate(key: string): boolean {
    if (this.seen.has(key)) {
      log.debug("Duplicate event detected", { key });
      return true;
    }
    this.seen.set(key, Date.now());
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, ts] of this.seen) {
      if (now - ts > this.ttlMs) {
        this.seen.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.debug("Idempotency store cleanup", { evicted, remaining: this.seen.size });
    }
  }
}

export const idempotencyStore = new IdempotencyStore();
