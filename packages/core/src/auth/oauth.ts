/**
 * The pure rules of the chat connector's sign-in (backlog #381,
 * `planning/chat-connector-spec.md` §6b): which redirect addresses a client may register, when a
 * requested redirect matches a registered one, and the PKCE check. No I/O; the stores are in
 * `db/platform/connector-oauth.ts` and the routes in `server/src/connector-oauth.ts`.
 *
 * Sources read for these rules, 2026-11-11: RFC 7636 (PKCE, S256), RFC 8252 §7.3 (a loopback
 * redirect matches on any port), and the chat host's connector authentication page (its fixed
 * callback address, and that its command-line client redirects to `localhost` as well as
 * `127.0.0.1`).
 */

import { createHash } from 'node:crypto';

/** The longest redirect address a client may register. */
export const MAX_REDIRECT_URI = 2000;

/** How many redirect addresses one client may register. */
export const MAX_REDIRECT_URIS = 5;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The address parsed, or null when it is not an absolute URL. */
function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/** Whether a redirect address is a loopback one: `http` on this machine, any port. */
export function isLoopbackRedirect(uri: string): boolean {
  const url = parse(uri);
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Why a redirect address cannot be registered, or null when it can. An address is `https`, or
 * `http` to this machine (a native client's loopback, RFC 8252); it carries no fragment and no
 * credentials, and is not longer than `MAX_REDIRECT_URI`. Anything else could send a code to a
 * page that is not the client's.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_REDIRECT_URI) {
    return 'a redirect address must be a URL of at most 2000 characters';
  }
  const url = parse(uri);
  if (url === null) return 'a redirect address must be an absolute URL';
  if (url.hash !== '' || uri.includes('#')) return 'a redirect address has no fragment';
  if (url.username !== '' || url.password !== '') {
    return 'a redirect address carries no credentials';
  }
  if (url.protocol === 'https:') return null;
  if (isLoopbackRedirect(uri)) return null;
  return 'a redirect address must be https, or http to this machine';
}

/**
 * Whether `requested` is one of the `registered` addresses. An exact match of the whole string,
 * except that a loopback address matches on any port (RFC 8252 §7.3): a native client listens
 * on a port it picks at the moment of signing in.
 */
export function redirectMatches(
  registered: readonly string[],
  requested: string,
): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const asked = parse(requested)!;
  return registered.some((uri) => {
    if (!isLoopbackRedirect(uri)) return false;
    const known = parse(uri)!;
    return (
      known.hostname === asked.hostname &&
      known.pathname === asked.pathname &&
      known.search === asked.search
    );
  });
}

// RFC 7636 §4.1: 43 to 128 characters of the unreserved set.
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
// base64url of a SHA-256 digest: 43 characters, no padding.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Whether a text has the shape of an S256 code challenge. */
export const isCodeChallenge = (text: unknown): text is string =>
  typeof text === 'string' && CHALLENGE.test(text);

/**
 * Whether `verifier` is the secret behind `challenge` (PKCE, method S256): the challenge is the
 * base64url SHA-256 of the verifier. A verifier of the wrong shape never matches.
 */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}
