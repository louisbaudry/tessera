/**
 * A fixed-window request limiter, in process (backlog #379, `planning/chat-connector-spec.md` §6).
 *
 * The chat connector's endpoint (`POST /api/mcp`) is the first route the protocol asks to be
 * rate limited (MCP 2025-06-18, Security Considerations). It is keyed by the connector token that
 * was presented, so one chat host's traffic cannot slow another's, and the counts live in memory:
 * the server is one process, and a restart resetting a window is harmless. A limit shared across
 * processes would need a store, and that is a decision for the whole API, not this endpoint.
 *
 * Only an authenticated request is counted (the gate calls this after the token resolves), so a
 * flood of invalid tokens cannot grow the table. The table is pruned of expired windows once it
 * passes `PRUNE_AT` entries, so its size tracks the tokens active in the last window.
 */

/** The answer for one request: allowed, or refused with how many seconds until a retry can succeed. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until the current window ends; `0` when allowed. */
  readonly retryAfterSeconds: number;
}

interface Window {
  start: number;
  count: number;
}

/** Entries kept before expired windows are swept out of the table. */
const PRUNE_AT = 10_000;

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  /**
   * @param limit maximum allowed requests per key in one window; must be at least 1.
   * @param windowMs length of a window in milliseconds; must be positive.
   * @throws RangeError when `limit` or `windowMs` is out of range.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive integer');
    if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
  }

  /**
   * Counts one request for `key` at time `now` and says whether it may proceed. A refused request
   * is not counted, so a client retrying after `retryAfterSeconds` is not penalised for trying.
   *
   * @param key the identity to count against (the connector token's hash, never the token).
   * @param now the time in milliseconds since the epoch; defaults to the current time.
   * @returns whether the request is allowed, and the wait in whole seconds when it is not.
   */
  take(key: string, now: number = Date.now()): RateLimitDecision {
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (this.windows.size >= PRUNE_AT) this.prune(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      const remaining = this.windowMs - (now - window.start);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
      };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drops every window that has ended by `now`. */
  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
