/**
 * Signed webhooks for the vendor events (`planning/vendor-spec.md`, its #125
 * implementation note): what an event looks like on the wire, how it is signed,
 * which URLs and addresses the server is willing to call, and when a failed
 * delivery is tried again. Pure: values in, values out, with only `node:crypto`
 * and `node:net`'s address parser as dependencies. Storing the queue and making
 * the request are `db`'s and the server's.
 *
 * The server calls a URL a person typed, so every rule here is deliberately
 * narrower than what would merely work: https only, the default port, a host
 * name and never an IP literal, and an address that must be public.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import type { AssignmentStatus } from './assignment.js';
import type { DeadlineNoticeKind } from './deadline.js';

/**
 * Every event an endpoint receives: a status entered, a deadline coming up or
 * passed (#155), the payable locking, and a test.
 */
export const WEBHOOK_EVENT_TYPES = [
  'assignment.offered',
  'assignment.pool_open',
  'assignment.claimed',
  'assignment.accepted',
  'assignment.declined',
  'assignment.in_progress',
  'assignment.delivered',
  'assignment.reviewed',
  'assignment.deadline_soon',
  'assignment.overdue',
  'payable.locked',
  'ping',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** A delivery's state; a frozen literal in the vendor schema's v6 migration. */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** At most this many endpoints for one owner. */
export const MAX_WEBHOOK_ENDPOINTS = 3;
/** A pending queue longer than this for one endpoint refuses new rows rather than growing. */
export const MAX_PENDING_WEBHOOKS = 500;
/** Longest URL accepted. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;
/** How long a request may take before it counts as failed. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** How much of a response is read (and none of it kept). */
export const WEBHOOK_MAX_RESPONSE_BYTES = 2048;
/** Delivered rows are pruned after this many days, failed ones after twice that and a bit. */
export const WEBHOOK_KEEP_DELIVERED_DAYS = 14;
export const WEBHOOK_KEEP_FAILED_DAYS = 30;

/** The event an assignment entering `status` is reported as. */
export function eventForStatus(status: AssignmentStatus): WebhookEventType {
  return `assignment.${status}`;
}

/** The event a deadline notice is reported as. */
export function eventForNotice(kind: DeadlineNoticeKind): WebhookEventType {
  return `assignment.${kind}`;
}

/** What the receiver reads: ids and states, never a name, note, rate or amount. */
export interface WebhookBody {
  /** The delivery's own id: the receiver dedupes on it (delivery is at least once). */
  readonly id: string;
  readonly type: WebhookEventType;
  /** ISO timestamp of the event, not of the attempt. */
  readonly createdAt: string;
  /** Null for `ping`. */
  readonly assignmentId: number | null;
  readonly from: AssignmentStatus | null;
  readonly to: AssignmentStatus | null;
  /** The vendor's platform account id, or null while a pool job has no vendor. */
  readonly vendorAccountId: number | null;
}

/** The exact bytes that are signed and sent: one fixed key order, so a receiver can re-sign. */
export function serializeWebhookBody(body: WebhookBody): string {
  return JSON.stringify({
    id: body.id,
    type: body.type,
    createdAt: body.createdAt,
    assignmentId: body.assignmentId,
    from: body.from,
    to: body.to,
    vendorAccountId: body.vendorAccountId,
  });
}

/** 32 random bytes, URL-safe: shown once when an endpoint is created. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}

const hmac = (secret: string, text: string): string =>
  createHmac('sha256', secret).update(text).digest('hex');

/**
 * The `X-Tessera-Signature` header value: `t=<unix seconds>,v1=<hex>`, where the
 * HMAC-SHA256 is over `<t>.<body>`. The timestamp is part of what is signed, so
 * a captured request cannot be replayed outside the receiver's window.
 */
export function signWebhook(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  return `t=${timestampSeconds},v1=${hmac(secret, `${timestampSeconds}.${body}`)}`;
}

/**
 * What a receiver does with the header: recompute and compare in constant time,
 * and refuse a timestamp more than `toleranceSeconds` from now. Exported so the
 * tests (and the documentation's example) use the receiver's side too.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const t = Number(match[1]);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(hmac(secret, `${t}.${body}`), 'hex');
  const given = Buffer.from(match[2]!, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Waits before attempts 2 to 6; a failed sixth attempt is final. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000, 300_000, 1_800_000, 7_200_000, 43_200_000,
] as const;

/**
 * Milliseconds to wait before the next attempt after `attempts` have failed, or
 * null when the delivery has used them all and is `failed` for good.
 */
export function nextAttemptDelayMs(attempts: number): number | null {
  return WEBHOOK_RETRY_DELAYS_MS[attempts - 1] ?? null;
}

/** Why a URL cannot be an endpoint, or the parsed URL when it can. */
export type UrlCheck =
  | { readonly ok: true; readonly url: URL; readonly host: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The shape rules, before any address is looked at: `https` only, no user info,
 * no fragment, the default port, a host name and never an IP literal. A
 * deployment that needs another port is a later, deliberate change.
 */
export function validateWebhookUrl(raw: string): UrlCheck {
  if (raw.length === 0 || raw.length > MAX_WEBHOOK_URL_LENGTH) {
    return { ok: false, reason: `a URL is 1 to ${MAX_WEBHOOK_URL_LENGTH} characters` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'that is not a URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'the URL must be https' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the URL must not carry a user name or password' };
  }
  if (url.hash !== '') return { ok: false, reason: 'the URL must not have a fragment' };
  if (url.port !== '')
    return { ok: false, reason: 'only the default https port is allowed' };
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0 || /^[0-9.]+$/.test(bare)) {
    return { ok: false, reason: 'use a host name, not an IP address' };
  }
  if (!host.includes('.') || host.endsWith('.')) {
    return { ok: false, reason: 'the host must be a public domain name' };
  }
  if (/\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) {
    return { ok: false, reason: 'the host must be a public domain name' };
  }
  return { ok: true, url, host };
}

/** The four bytes of a dotted IPv4 address, or null. */
function v4Octets(ip: string): [number, number, number, number] | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.').map(Number);
  return parts.length === 4 ? (parts as [number, number, number, number]) : null;
}

/** Whether a dotted IPv4 address is routable on the public internet. */
function isPublicV4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF and documentation
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function v6Groups(ip: string): number[] | null {
  const bare = ip.split('%')[0]!.toLowerCase();
  if (isIP(bare) !== 6) return null;
  let text = bare;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const o = v4Octets(tail[1]!);
    if (!o) return null;
    text =
      text.slice(0, -tail[1]!.length) +
      ((o[0] << 8) | o[1]).toString(16) +
      ':' +
      ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const numbers = groups.map((g) => parseInt(g, 16));
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n))
    ? numbers
    : null;
}

/**
 * Whether the server may connect to this address: only a public one. Everything
 * that is not a plain public unicast address is refused, and a form that embeds
 * an IPv4 address (IPv4-mapped, NAT64, 6to4) is judged by the IPv4 inside it,
 * because that is where the connection would really go. An address that does
 * not parse is not public.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = v4Octets(ip);
  if (v4) return isPublicV4(v4[0], v4[1], v4[2]);
  const g = v6Groups(ip);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => isPublicV4(hi >> 8, hi & 0xff, lo >> 8);
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return embedded(g[6]!, g[7]!); // 64:ff9b::a.b.c.d
  }
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4 embeds the v4 in groups 1 and 2
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return (g[0]! & 0xe000) === 0x2000; // only global unicast 2000::/3
}
