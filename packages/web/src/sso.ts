/**
 * The login screen's side of signing in with Microsoft 365 or Google (backlog #214,
 * `planning/sso-spec.md` D4): reading the hand-off code the callback host leaves in the
 * address, the browser secret that binds a sign-in to the browser that started it, and the
 * words for each provider. Pure where it can be, so it is tested in node; the storage that
 * keeps the secret across the trip to the provider is the only part that touches the browser.
 */
import type { SsoProvider } from '@cat-tool/core';

import { isInviteToken } from './route.js';

/** A `Record` over core's union, so a provider added there fails this typecheck until it is worded here. */
export const PROVIDER_LABEL: Record<SsoProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

/** What the callback host puts after `#sso=`: a base64url code, or the word `refused`. */
const CODE = /^[A-Za-z0-9_-]{20,200}$/;

export type SsoFragment =
  { readonly kind: 'code'; readonly code: string } | { readonly kind: 'refused' };

/**
 * What a returning sign-in left in the address, or `null` when the hash is anything else. The
 * code lives in the fragment, which a browser never sends to a server, and is read once:
 * the caller clears it from the address before it does anything else.
 */
export function parseSsoFragment(hash: string): SsoFragment | null {
  if (!hash.startsWith('#sso=')) return null;
  const value = hash.slice('#sso='.length);
  if (value === 'refused') return { kind: 'refused' };
  return CODE.test(value) ? { kind: 'code', code: value } : null;
}

/**
 * The secret this browser keeps while it is away at the provider, 32 random bytes as base64url.
 * The server stores only its hash and asks for it again to redeem the code, so a code presented
 * by any other browser is refused (a login CSRF). `random` is `crypto.getRandomValues` in the
 * page and a fixed source in a test.
 */
export function makeBinding(random: (length: number) => Uint8Array): string {
  const bytes = random(32);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const KEY = 'cat-tool.sso-binding';

/**
 * Session storage, not local storage: the secret only has to outlive the trip to the provider
 * in this tab, and should not outlive the tab. Storage can be absent or throw (private
 * windows); then no sign-in by provider can complete, and the screen says so.
 */
export function saveBinding(binding: string): boolean {
  try {
    sessionStorage.setItem(KEY, binding);
    return true;
  } catch {
    return false;
  }
}

export function loadBinding(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearBinding(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing kept to clear.
  }
}

/**
 * What the page was doing when it left for the provider (issue #317, `planning/sso-spec.md`
 * §2a): the callback host always sends the browser back to `/#sso=<code>`, so the page that
 * started the sign-in keeps here what to do with the code it brings back. A login keeps nothing
 * (no record is a login), a link needs the session it started in, and an invitation needs its
 * link's token, which the server asks for again.
 */
export type PendingSso =
  | { readonly purpose: 'link' }
  | {
      readonly purpose: 'staff_invite' | 'vendor_invite' | 'join';
      readonly token: string;
    };

/**
 * A kept record read back, or `null` for anything that is not one: storage another script could
 * have written is checked as a request would be.
 */
export function parsePending(text: string | null): PendingSso | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { purpose, token } = value as { purpose?: unknown; token?: unknown };
  if (purpose === 'link') return { purpose };
  if (
    (purpose === 'staff_invite' || purpose === 'vendor_invite' || purpose === 'join') &&
    typeof token === 'string' &&
    isInviteToken(token)
  ) {
    return { purpose, token };
  }
  return null;
}

const PENDING_KEY = 'cat-tool.sso-pending';

/** Keeps what the page was doing, in this tab only, as the browser secret is kept. */
export function savePending(pending: PendingSso | null): boolean {
  try {
    if (pending === null) sessionStorage.removeItem(PENDING_KEY);
    else sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

/** What a returning sign-in is for, read once: the record is removed as it is read. */
export function takePending(): PendingSso | null {
  try {
    const text = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return parsePending(text);
  } catch {
    return null;
  }
}

/**
 * Leaves for a provider: makes and keeps this browser's secret and what the page was doing, asks
 * the server where to go with `start`, and sends the browser there. Resolves to a message to show
 * when it cannot leave (no storage, or the server refused); otherwise the page is gone.
 */
export async function leaveForProvider(
  start: (binding: string) => Promise<{ url: string }>,
  pending: PendingSso | null,
): Promise<string> {
  const binding = makeBinding((n) => crypto.getRandomValues(new Uint8Array(n)));
  if (!saveBinding(binding) || !savePending(pending)) {
    return 'This browser will not keep what a sign-in needs. Use a password instead.';
  }
  try {
    const { url } = await start(binding);
    window.location.assign(url);
    return '';
  } catch (err) {
    clearBinding();
    savePending(null);
    return err instanceof Error ? err.message : String(err);
  }
}
