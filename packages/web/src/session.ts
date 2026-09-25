/**
 * The bearer token, in `localStorage` (v1-spec.md §7.1): the server's
 * session lasts 30 days, and a token that died with the tab would make
 * that a lie. Storage can be absent or throw (private windows, blocked
 * site data); then the session simply lasts as long as the page.
 */

const KEY = 'cat-tool.session';

export function loadToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Not persisted; the in-memory session still works.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing persisted to clear.
  }
}
