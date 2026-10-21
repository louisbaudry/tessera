/**
 * Concordance search (`v1-spec.md` §6.1b; issue #170): one read route over the
 * project's attached memories.
 *
 * Owner-only (`manage`). A hit is a whole unit from the owner's memories, and a
 * base memory is often shared across clients, so what a translator on a grant
 * may search is the owner's call and not a default (the same reason `GET
 * /api/projects/:name/resources` returns no slug, id or path). A grantee gets
 * the 403 every `manage` route gives them.
 *
 * The match is an FTS5 phrase read, unranked and capped (`tm-format-spec.md`
 * §11), so it runs on the request thread; it writes nothing and logs nothing.
 */

import {
  CONCORDANCE_SIDES,
  concordanceProblem,
  type ConcordanceSide,
  type ProjectAction,
} from '@cat-tool/core';
import { searchConcordance, type Account, type openProjectDb } from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ConcordanceRouteDeps {
  /** `openProject` of `app.ts`: answers 404/403 itself and returns null. */
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ReturnType<typeof openProjectDb>; path: string; owner: Account } | null;
}

export function registerConcordanceRoutes(
  app: FastifyInstance,
  deps: ConcordanceRouteDeps,
): void {
  // `q` is the text to look up and `side` the language searched (default
  // `source`). A `q` with no word is an empty answer, not a 400: a box being
  // typed into is empty before it is not.
  app.get<{ Params: { name: string }; Querystring: { q?: unknown; side?: unknown } }>(
    '/api/projects/:name/concordance',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        const { q, side = 'source' } = req.query;
        if (typeof q !== 'string') {
          return reply.code(400).send({ error: 'q must be the text to look up' });
        }
        if (!CONCORDANCE_SIDES.includes(side as ConcordanceSide)) {
          return reply.code(400).send({ error: 'side must be "source" or "target"' });
        }
        const problem = concordanceProblem(q);
        if (problem !== null) return reply.code(400).send({ error: problem });
        const found = searchConcordance(opened.db, {
          text: q,
          side: side as ConcordanceSide,
        });
        return {
          hits: found.hits.map((hit) => ({
            tuId: hit.tuId,
            memory: hit.memory,
            source: hit.sourcePlain,
            target: hit.targetPlain,
            ranges: hit.ranges,
            updatedAt: hit.updatedAt,
          })),
          more: found.more,
          searched: found.searched,
        };
      } finally {
        opened.db.close();
      }
    },
  );
}
