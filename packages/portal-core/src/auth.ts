/**
 * Admin password/session primitives (portal-v0-spec.md §7).
 *
 * One definition, in `@cat-tool/core` (`auth/credentials.ts`) since the
 * CAT server's accounts (backlog #27) need the same functions;
 * re-exported here so nothing in the portal had to change. Storage
 * (looking up an `admin_user`/`admin_session` row) is still
 * `packages/db/src/portal/admin.ts`.
 */
export {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  SESSION_TTL_MS,
  verifyPassword,
} from '@cat-tool/core';
