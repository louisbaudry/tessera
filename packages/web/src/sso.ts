/**
 * The login screen's side of signing in with Microsoft 365 or Google (backlog #214,
 * `planning/sso-spec.md` D4): reading the hand-off code the callback host leaves in the
 * address, the browser secret that binds a sign-in to the browser that started it, and the
 * words for each provider. Pure where it can be, so it is tested in node; the storage that
 * keeps the secret across the trip to the provider is the only part that touches the browser.
 */
import type { SsoProvider } from '@cat-tool/core';

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
