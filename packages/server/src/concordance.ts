/**
 * Concordance search and correcting what it finds (`v1-spec.md` §6.1b and
 * §6.1c; issues #170, #151): one read route over the project's attached
 * memories, and two writes on the units it shows.
 *
 * Owner-only (`manage`). A hit is a whole unit from the owner's memories, and a
 * base memory is often shared across clients, so what a translator on a grant
 * may search, or change, is the owner's call and not a default (the same reason
 * `GET /api/projects/:name/resources` returns no slug, id or path). A grantee
 * gets the 403 every `manage` route gives them.
 *
 * The search is an FTS5 phrase read, unranked and capped (`tm-format-spec.md`
 * §11), so it runs on the request thread, and writes nothing. The writes name a
 * memory by the project's own `tm_ref` id and a unit by the revision the hit
 * carried, so a stale one is a 409 and a path never arrives; each is logged in
 * the project (`tm.unit_edited`, `tm.unit_retired`) under `sessionActor`.
 */

import {
  CONCORDANCE_SIDES,
  concordanceProblem,
  type AuditActor,
  type ConcordanceSide,
  type ProjectAction,
} from '@cat-tool/core';
import {
  editMemoryUnit,
  NoSuchMemoryError,
  retireMemoryUnit,
  searchConcordance,
  UnitEditError,
  type Tenant,
  type openProjectDb,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ConcordanceRouteDeps {
  /** `sessionActor` of `app.ts`: who a write is logged as, never built in a handler. */
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** `openProject` of `app.ts`: answers 404/403 itself and returns null. */
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ReturnType<typeof openProjectDb>; path: string; tenant: Tenant } | null;
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
            // What an edit names: the project's own reference, never a path.
            ref: hit.ref,
            tuvId: hit.targetTuvId,
            rev: hit.targetRev,
            editable: hit.editable,
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

  /** A positive integer from a body, or null. */
  const id = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;

  /** The answer for a write the memory or the project refused. */
  const refused = (reply: FastifyReply, err: unknown) => {
    if (err instanceof NoSuchMemoryError) {
      return reply.code(404).send({ error: 'no such memory in this project' });
    }
    if (err instanceof UnitEditError) {
      switch (err.reason) {
        case 'not_found':
          return reply.code(404).send({ error: err.message });
        case 'stale':
        case 'read_only':
          return reply.code(409).send({ error: err.message });
        case 'tagged':
          return reply.code(422).send({ error: err.message });
        case 'blank':
        case 'too_long':
          return reply.code(400).send({ error: err.message });
      }
    }
    throw err;
  };

  // Corrects one translation in a memory the hit came from: `{ ref, tuvId, rev,
  // text }`, the first three as the hit carried them. `rev` is checked, so a unit
  // changed since it was read is a 409 and nothing is written (`v1-spec.md` §6.1c).
  app.put<{
    Params: { name: string };
    Body: { ref?: unknown; tuvId?: unknown; rev?: unknown; text?: unknown };
  }>('/api/projects/:name/memory-units', async (req, reply) => {
    const opened = deps.openProject(req, reply, req.params.name, 'manage');
    if (!opened) return reply;
    try {
      const { ref, tuvId, rev, text } = req.body ?? {};
      if (id(ref) === null || id(tuvId) === null || id(rev) === null) {
        return reply
          .code(400)
          .send({ error: 'ref, tuvId and rev must be positive integers' });
      }
      if (typeof text !== 'string') {
        return reply.code(400).send({ error: 'text must be the new translation' });
      }
      try {
        const result = editMemoryUnit(opened.db, {
          ref: ref as number,
          tuvId: tuvId as number,
          baseRev: rev as number,
          text,
          actor: deps.sessionActor(req),
        });
        return { changed: result.changed, rev: result.toRev };
      } catch (err) {
        return refused(reply, err);
      }
    } finally {
      opened.db.close();
    }
  });

  // Retires one memory unit (a tombstone, `tm-format-spec.md` §7): `{ ref, tuvId, rev }`.
  app.post<{
    Params: { name: string };
    Body: { ref?: unknown; tuvId?: unknown; rev?: unknown };
  }>('/api/projects/:name/memory-units/retire', async (req, reply) => {
    const opened = deps.openProject(req, reply, req.params.name, 'manage');
    if (!opened) return reply;
    try {
      const { ref, tuvId, rev } = req.body ?? {};
      if (id(ref) === null || id(tuvId) === null || id(rev) === null) {
        return reply
          .code(400)
          .send({ error: 'ref, tuvId and rev must be positive integers' });
      }
      try {
        const result = retireMemoryUnit(opened.db, {
          ref: ref as number,
          tuvId: tuvId as number,
          baseRev: rev as number,
          actor: deps.sessionActor(req),
        });
        return { changed: result.changed };
      } catch (err) {
        return refused(reply, err);
      }
    } finally {
      opened.db.close();
    }
  });
}
