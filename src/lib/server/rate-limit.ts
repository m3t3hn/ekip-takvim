// How often something may happen, counted in memory: a restart starts over.

/**
 * The address a request came from: Cloudflare's cf-connecting-ip, else the
 * last X-Forwarded-For entry (the one the nearest proxy added), else "unknown".
 */
export function clientAddress(headers: Headers): string {
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  return headers.get("x-forwarded-for")?.split(",").pop()?.trim() || "unknown";
}

/**
 * At most `limit` events per key in any `windowMs`: an event is within the
 * limit when fewer than `limit` came under its key in the window before it.
 * Every event counts, refused ones too, so a key that keeps trying stays
 * refused. Each key keeps only its last `limit` times still in the window,
 * which is all that decides the next answer; keys with none are dropped, and
 * past `maxKeys` the oldest keys go, so it stays small whatever the traffic.
 */
export class SlidingLimit {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys = 10_000,
  ) {}

  /**
   * Count one event under `key` at `now`, whatever the answer. True when it is
   * within the limit: fewer than `limit` events came in the window before it.
   */
  hit(key: string, now: number): boolean {
    if (now - this.lastSweep >= this.windowMs) {
      this.lastSweep = now;
      for (const k of [...this.hits.keys()]) this.recent(k, now);
    }
    const times = this.recent(key, now);
    const within = times.length < this.limit;
    times.push(now);
    if (times.length > this.limit) times.shift();
    // Newest last, so the oldest keys are the first to go.
    this.hits.delete(key);
    this.hits.set(key, times);
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(k);
    }
    return within;
  }

  /**
   * How long from `now` until an event under `key` would be within the limit,
   * in ms; 0 when one would be now. Nothing is counted. It's exact while no
   * other event comes under the key: the oldest of its last `limit` events
   * has to leave the window first.
   */
  wait(key: string, now: number): number {
    const times = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (times.length < this.limit) return 0;
    return times[times.length - this.limit] + this.windowMs - now;
  }

  /** The key's event times still in the window; a key left with none is dropped. */
  private recent(key: string, now: number): number[] {
    const times = this.hits.get(key);
    if (!times) return [];
    while (times.length && times[0] <= now - this.windowMs) times.shift();
    if (!times.length) this.hits.delete(key);
    return times;
  }
}
