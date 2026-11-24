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
 * and what became of each reply. No segment, source, draft or prompt, and no price.
 */

import {
  openProjectDb,
  readAiUsage,
  sumAiUsage,
  type AiUsage,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { listProjectNames, projectPath } from './storage.js';

export interface AiSpendRouteDeps {
  readonly storageRoot: string;
  /** The session's tenant if its role may see spend; null for a vendor; throws for a pm. */
  readonly tenant: (req: FastifyRequest) => Tenant | null;
}

const EMPTY: AiUsage = { rows: [], calls: 0 };

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
}
