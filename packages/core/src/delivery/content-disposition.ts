/**
 * The `Content-Disposition` a download carries — one definition for both
 * servers (the CAT server's export, the portal's deliveries), in `core`
 * the way `auth/credentials.ts` is. A pure string formatter: `core`
 * still never touches HTTP itself.
 */

/**
 * RFC 6266's `attachment`, with an ASCII-only `filename` for old
 * clients and the real name in RFC 8187 `filename*` for everyone else.
 * Quotes, backslashes and control characters can't appear in the quoted
 * fallback, so they become `_`.
 */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
