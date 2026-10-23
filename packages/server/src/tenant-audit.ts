/**
 * A tenant admin reads their own slice of the platform log (backlog #211,
 * `planning/audit-spec.md` §3.1): `GET /api/audit`, newest first, a page at a time. Admin
 * only (`tenantFor(req, 'audit')`): the log names every staff member's acts. The tenant
 * is the session's, never the request's (spec D6), so there is no way to ask for another's;
 * a vendor, who has none, is shown an empty list as on every other tenant-only read.
 *
 * What it returns is what the log holds and nothing more: ids, states and the labels
 * snapshotted when each event was written (a person's label reads `[erased]` once erased).
 */

import { listTenantEvents, type openPlatformDb, type Tenant } from '@cat-tool/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type Platform = ReturnType<typeof openPlatformDb>;

export interface TenantAuditRouteDeps {
  readonly platform: Platform;
  /** The session's tenant if its role may read the log; null for a vendor; throws for a pm. */
  readonly tenant: (req: FastifyRequest) => Tenant | null;
}

/** A whole number from a query string, or `undefined` when absent; `null` when present and not one. */
function wholeNumber(raw: unknown, min: number): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min ? n : null;
}

export function registerTenantAuditRoutes(
  app: FastifyInstance,
  deps: TenantAuditRouteDeps,
): void {
  app.get<{ Querystring: { limit?: string; before?: string } }>(
    '/api/audit',
    async (req, reply) => {
      const tenant = deps.tenant(req);
      if (!tenant) return { events: [], next: null };
      const limit = wholeNumber(req.query.limit, 1);
      const before = wholeNumber(req.query.before, 1);
      if (limit === null || before === null) {
        return reply
          .code(400)
          .send({ error: 'limit and before are positive whole numbers' });
      }
      const events = listTenantEvents(deps.platform, tenant.id, {
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { beforeId: before }),
      });
      // A full page may have more behind it; the next request asks `before` its oldest id.
      const asked = limit ?? 100;
      const next =
        events.length >= Math.min(asked, 500) ? (events.at(-1)?.id ?? null) : null;
      return { events, next };
    },
  );
}
