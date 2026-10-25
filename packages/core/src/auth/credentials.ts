/**
 * Password and session-token primitives, shared by every login this
 * platform has: the translation portal's admin (`portal-v0-spec.md` §7)
 * and the CAT server's accounts (`v1-spec.md` §4.1a, backlog #27).
 *
 * Pure functions over `node:crypto` only — no DB, no HTTP — which is
 * what lets them live in `core`. They started in `@cat-tool/portal-core`
 * and moved here when the CAT server needed the same four functions:
 * a second copy would have been the drift `CLAUDE.md`'s
 * single-definition rule exists to prevent, and the CAT engine's shell
 * importing the portal product for a hash function was the wrong
 * direction. `portal-core` re-exports these unchanged. Storage (looking
 * a row up by the hashes) is `db/portal/admin.ts` and
 * `db/platform/accounts.ts`.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 64;

/** A session stays valid for 30 days from creation. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `scrypt` salt:hash, both hex — self-contained, no separate salt column needed. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * What `account.password_hash` holds for an account made by signing in with a provider
 * (`planning/sso-spec.md` D3): no password at all. `account` is a referenced table, which
 * `rebuildTable` refuses, so the column stays `NOT NULL` and holds this instead. It has no
 * `:`, so {@link verifyPassword} can never match it, whatever is typed; the login route
 * still asks {@link hasPassword} first, so a refusal does not depend on that accident.
 */
export const NO_PASSWORD_HASH = '!';

/** Whether a stored hash is a password's, and not the {@link NO_PASSWORD_HASH} sentinel. */
export const hasPassword = (stored: string): boolean => stored !== NO_PASSWORD_HASH;

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  // Buffers must be equal length for timingSafeEqual — a malformed stored
  // hash (wrong length) is a mismatch, not a crash.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A URL-safe bearer token handed to the client; never stored raw. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What's actually stored/looked-up server-side, so a DB leak doesn't hand
 * out live sessions. Plain SHA-256, not `scrypt`: the token is already a
 * 256-bit random secret (not a low-entropy password), so a slow KDF only
 * costs every request latency for no security benefit — every login
 * lookup hashes one of these on the hot path.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
