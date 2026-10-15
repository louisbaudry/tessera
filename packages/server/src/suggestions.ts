/**
 * What a translator sees and does with a draft (backlog #138;
 * `planning/translation-engine-spec.md` D3, D20, D34, D35): list the current
 * suggestions, ask for one segment now, accept one.
 *
 * All three are `edit` routes, because the translator is the one person the
 * engine is invisible to: **what they reach returns tokens and nothing else**. No
 * engine, model, prompt version or digest is in any answer, and asking for a draft
 * answers `{ tokens: null }` alike when the engine is off, unconfigured, refused,
 * failed or had nothing, so a translator cannot tell which. The consent that
 * governs a request is the project owner's (`engineFor` over `opened.owner`), and
 * `ai.requested` names the translator who asked, the accountable human.
 */

import type { AuditActor, DraftEngineAdapter, ProjectAction } from '@cat-tool/core';
import {
  acceptDraftSuggestion,
  draftSuggestions,
  getDraftSuggestion,
  getSegment,
  listDraftSuggestions,
  NoSuggestionError,
  SegmentRepoError,
  TargetConflictError,
  type Account,
  type openPlatformDb,
  type openProjectDb,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdapterFor } from './draft.js';
import { engineFor } from './engine.js';

export interface SuggestionRouteDeps {
  readonly platform: ReturnType<typeof openPlatformDb>;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** `openProject` of `app.ts`: answers 404/403 itself and returns null. */
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ReturnType<typeof openProjectDb>; path: string; owner: Account } | null;
  readonly adapterFor: AdapterFor;
}

export function registerSuggestionRoutes(
  app: FastifyInstance,
  deps: SuggestionRouteDeps,
): void {
  const { platform } = deps;
  /** Requests being drafted now, so two tabs (or a double key) make one call. */
  const drafting = new Set<string>();

  const segmentIdOf = (raw: string): number | null => {
    const id = Number(raw);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
  };

  app.get<{ Params: { name: string } }>(
    '/api/projects/:name/suggestions',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'edit');
      if (!opened) return reply;
      try {
        return {
          suggestions: listDraftSuggestions(opened.db).map((s) => ({
            segmentId: s.segmentId,
            tokens: s.targetTokens,
          })),
        };
      } finally {
        opened.db.close();
      }
    },
  );

  app.post<{ Params: { name: string; segmentId: string } }>(
    '/api/projects/:name/segments/:segmentId/suggestion',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'edit');
      if (!opened) return reply;
      const { db } = opened;
      const key = `${opened.owner.id}/${req.params.name}/${req.params.segmentId}`;
      try {
        const id = segmentIdOf(req.params.segmentId);
        if (id === null || !getSegment(db, id)) {
          return reply.code(404).send({ error: `no segment #${req.params.segmentId}` });
        }
        const have = getDraftSuggestion(db, id);
        if (have) return { tokens: have.targetTokens };

        const gate = () => engineFor(platform, opened.owner.id, db);
        const decision = gate();
        const adapter: DraftEngineAdapter | null =
          decision.engine === 'off' ? null : deps.adapterFor(decision.engine);
        if (!adapter || drafting.has(key)) return { tokens: null };

        drafting.add(key);
        try {
          const summary = await draftSuggestions(db, {
            actor: deps.sessionActor(req),
            adapter,
            gate,
            segmentIds: [id],
          });
          if (summary.stop === 'engine_error') {
            // The adapter's message names a status and a type only, never a
            // body or a key (anthropic-engine.ts), and is for the log, not the translator.
            app.log.warn({ reason: summary.error }, 'a draft request failed');
          }
        } finally {
          drafting.delete(key);
        }
        return { tokens: getDraftSuggestion(db, id)?.targetTokens ?? null };
      } finally {
        db.close();
      }
    },
  );

  app.post<{
    Params: { name: string; segmentId: string };
    Body: { baseUpdatedAt?: unknown };
  }>('/api/projects/:name/segments/:segmentId/suggestion/accept', async (req, reply) => {
    const opened = deps.openProject(req, reply, req.params.name, 'edit');
    if (!opened) return reply;
    const { db } = opened;
    try {
      const id = segmentIdOf(req.params.segmentId);
      if (id === null || !getSegment(db, id)) {
        return reply.code(404).send({ error: `no segment #${req.params.segmentId}` });
      }
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'the body must be a JSON object' });
      }
      const { baseUpdatedAt } = body;
      if (baseUpdatedAt !== undefined && typeof baseUpdatedAt !== 'string') {
        return reply.code(400).send({ error: 'baseUpdatedAt must be a string' });
      }
      try {
        return acceptDraftSuggestion(db, id, {
          actor: deps.sessionActor(req),
          baseUpdatedAt,
        });
      } catch (err) {
        if (err instanceof NoSuggestionError) {
          return reply
            .code(404)
            .send({ error: 'there is no suggestion for this segment' });
        }
        if (err instanceof TargetConflictError) {
          return reply.code(409).send({ error: err.message, segment: err.current });
        }
        if (err instanceof SegmentRepoError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    } finally {
      db.close();
    }
  });
}
