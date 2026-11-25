/**
 * The owner's AI spend view (issue #150, `planning/translation-engine-spec.md`, the #150
 * note): `GET /api/ai-spend`, what the tenant's draft runs cost, per project and in total.
 *
 * **Admin only** (`tenantFor(req, 'consent')`, the engine settings' own action): spend is the
 * owner's business and no translator or vendor sees an engine anywhere (D20). The tenant is
 * the session's, never the request's, so there is no way to ask for another's; a vendor, who
 * has none, is shown an empty view as on every other tenant-only read.
 *
 * Units only: engine, model, unit (tokens, or characters for DeepL), input and output counts
 * and what became of each reply. No source, draft or prompt, and no price.
 *
 * `GET /api/projects/:name/ai-calls` is the per-call log behind one project's sums (issue #150's
 * remainder): its `ai_usage` rows, newest first, a page at a time, each with the segment's id
 * and nothing more of the segment. Same rule for who: an admin of the tenant the project lives
 * in, and never through a grant, so a `?tenant=` naming anyone else is the 404 of a missing
 * project (the project routes' own answer), as is a vendor's request.
 */

import { existsSync } from 'node:fs';

import {
  listAiCalls,
  openProjectDb,
  readAiUsage,
  sumAiUsage,
  type AiUsage,
  type Tenant,
} from '@cat-tool/db';
import { isSlug } from '@cat-tool/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { InvalidNameError, listProjectNames, projectPath } from './storage.js';

export interface AiSpendRouteDeps {
  readonly storageRoot: string;
  /** The session's tenant if its role may see spend; null for a vendor; throws for a pm. */
  readonly tenant: (req: FastifyRequest) => Tenant | null;
}

const EMPTY: AiUsage = { rows: [], calls: 0 };

/** A page of the per-call log when the request names no size. */
export const AI_CALL_PAGE_DEFAULT = 50;

/** A positive integer of at most 15 digits, or undefined for anything else. */
function positive(value: unknown): number | undefined {
  return typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value)
    ? Number(value)
    : undefined;
}

export function registerAiSpendRoutes(
  app: FastifyInstance,
  deps: AiSpendRouteDeps,
): void {
  app.get('/api/ai-spend', async (req) => {
    const tenant = deps.tenant(req);
    if (!tenant) return { projects: [], total: EMPTY };
    const projects = listProjectNames(deps.storageRoot, tenant)
      .map((name) => {
        const db = openProjectDb(projectPath(deps.storageRoot, tenant, name));
        try {
          return { name, usage: readAiUsage(db) };
        } finally {
          db.close();
        }
      })
      // A project nothing was drafted in is not a line of the view.
      .filter((p) => p.usage.calls > 0);
    return { projects, total: sumAiUsage(projects.map((p) => p.usage)) };
  });
  app.get('/api/projects/:name/ai-calls', async (req, reply) => {
    const { name } = req.params as { name: string };
    const query = (req.query ?? {}) as {
      tenant?: unknown;
      before?: unknown;
      limit?: unknown;
    };
    const missing = () => reply.code(404).send({ error: `no project named "${name}"` });
    const tenant = deps.tenant(req);
    // Spend is never opened by a grant: `?tenant=` may only name the session's own tenant.
    if (!tenant || (query.tenant !== undefined && positive(query.tenant) !== tenant.id))
      return missing();
    if (!isSlug(name))
      return reply
        .code(400)
        .send({ error: new InvalidNameError('project', name).message });
    const path = projectPath(deps.storageRoot, tenant, name);
    if (!existsSync(path)) return missing();
    if (query.before !== undefined && positive(query.before) === undefined)
      return reply.code(400).send({ error: 'before must be a call id' });
    if (query.limit !== undefined && positive(query.limit) === undefined)
      return reply.code(400).send({ error: 'limit must be a positive number' });
    const db = openProjectDb(path);
    try {
      const before = positive(query.before);
      return listAiCalls(db, {
        limit: positive(query.limit) ?? AI_CALL_PAGE_DEFAULT,
        ...(before === undefined ? {} : { before }),
      });
    } finally {
      db.close();
    }
  });
}
