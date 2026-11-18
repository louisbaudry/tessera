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
 *
 * The routes a chat host calls before anyone is signed in have no token to count by, so they are
 * counted by sender (issue #384, spec §6b D23): `clientAddress` says which network address a
 * request came from, given how many reverse proxies the operator said to trust, and `senderKey`
 * turns it into the key one sender cannot multiply. There the table tracks the senders seen in
 * the last window; a flood from many networks at once is the reverse proxy's to stop, not this.
 */

import { isIP } from 'node:net';

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
   * @param key the identity to count against (a connector token's hash, never the token; or a
   *   `senderKey`).
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

/** The most reverse proxies a deployment may say it trusts (`CAT_TRUSTED_PROXIES`). */
export const MAX_TRUSTED_PROXIES = 8;

/** One address out of an `X-Forwarded-For` entry, or null when it is not an IP address. */
function forwardedAddress(entry: string): string | null {
  const value = entry.trim();
  return isIP(value) !== 0 ? value : null;
}

/**
 * The network address a request came from, behind `trustedProxies` reverse proxies.
 *
 * With none trusted it is the connection's own peer and the `X-Forwarded-For` header is ignored:
 * whoever sends a request writes that header, so reading it on a server reached directly would
 * let a sender pick the address it is counted under. With `n` trusted, the connection's peer is
 * the nearest proxy and the client is the `n`th entry from the right of the header, each proxy
 * having appended the address it was called from. Entries further left are the sender's claim
 * and are never read.
 *
 * It never fails: a header shorter than the trusted count, or an entry that is no address, is a
 * request that did not come through the proxies as configured, and it is counted under the
 * connection's peer, so such requests share one window instead of escaping the limit.
 *
 * @param peer the address of the connection itself (Fastify's `req.ip` with no `trustProxy`).
 * @param forwardedFor the `X-Forwarded-For` header as Node hands it over.
 * @param trustedProxies how many reverse proxies stand in front of the server; 0 for none.
 * @returns an IP address as text, or `peer` unchanged when nothing better is known.
 */
export function clientAddress(
  peer: string,
  forwardedFor: string | readonly string[] | undefined,
  trustedProxies: number,
): string {
  if (trustedProxies < 1 || forwardedFor === undefined) return peer;
  const entries = [forwardedFor].flat().join(',').split(',');
  if (entries.length < trustedProxies) return peer;
  return forwardedAddress(entries[entries.length - trustedProxies]!) ?? peer;
}

/** The eight groups of an IPv6 address, each as lower-case hex with no leading zero, or null. */
function ipv6Groups(address: string): string[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  return groups.map((group) => parseInt(group, 16).toString(16));
}

/**
 * The key a sender is counted under: an IPv4 address whole, an IPv6 address by its first 64
 * bits. One IPv6 subscriber is routinely given a whole /64 and can use any address in it, so
 * counting each address apart would give one sender as many windows as it cares to open. An
 * IPv4 address written inside IPv6 (`::ffff:192.0.2.1`, how a dual-stack socket reports it)
 * counts as that IPv4 address, so one sender is not two.
 *
 * @param address an IP address as text; anything else is returned as it came, as one key.
 * @returns the key to hand to `FixedWindowLimiter.take`.
 */
export function senderKey(address: string): string {
  // A zone id (`fe80::1%eth0`) names an interface of this machine, not the sender.
  const bare = address.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  if (isIP(bare) !== 6) return bare;
  // Any other IPv6 form that ends in dotted digits keeps its text: the first 64 bits are in the
  // hex groups before it, and such addresses are not routed on the public internet.
  if (bare.includes('.')) return bare;
  const groups = ipv6Groups(bare);
  return groups === null ? bare : `${groups.slice(0, 4).join(':')}::/64`;
}
