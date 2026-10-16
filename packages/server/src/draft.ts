/**
 * Starting a drafting run (backlog #136; `planning/translation-engine-spec.md`
 * D4, D5, D20, D26): `POST /api/projects/:name/draft`.
 *
 * **Owner-only and `manage`**, as every engine route (D20): a translator or a
 * vendor never starts one, never polls one and sees no engine anywhere. The
 * answer is a job the account polls and cancels at `/api/jobs/:id`, like any
 * bulk work (§1.1), because a run is minutes of network calls, never a request.
 *
 * The route decides nothing about consent itself: `engineFor` does, here to
 * refuse early with the reason and again before every segment inside the run
 * (`startDraftRun`), so a withdrawal mid-run stops it. Two more refusals are
 * plain facts about the server: the engine asked for has no key configured, and a
 * run is already going for the account.
 */

import type {
  AuditActor,
  DraftEngine,
  DraftEngineAdapter,
  ProjectAction,
} from '@cat-tool/core';
import { type Account, type openPlatformDb, type openProjectDb } from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createAnthropicAdapter } from './anthropic-engine.js';
import { createDeeplAdapter } from './deepl-engine.js';
import { DEFAULT_DRAFT_MODEL, type ServerConfig } from './config.js';
import { startDraftRun } from './draft-job.js';
import { engineFor } from './engine.js';
import { MAX_RUNNING_JOBS, type JobRegistry } from './jobs.js';

/** Which adapter serves an engine; `null` when none can. A test seam: a deployment passes nothing. */
export type AdapterFor = (engine: DraftEngine) => DraftEngineAdapter | null;

/**
 * The deployment's adapters: Anthropic for the Tessera engine and DeepL for the
 * `deepl` engine, each when its key is configured. The one place an adapter is
 * built, so each key is read here and nowhere else.
 */
export function defaultAdapterFor(config: ServerConfig): AdapterFor {
  return (engine) => {
    if (engine === 'tessera') {
      return config.anthropicApiKey
        ? createAnthropicAdapter({
            apiKey: config.anthropicApiKey,
            model: config.draftModel ?? DEFAULT_DRAFT_MODEL,
          })
        : null;
    }
    return config.deeplApiKey ? createDeeplAdapter({ apiKey: config.deeplApiKey }) : null;
  };
}

export interface DraftRouteDeps {
  readonly platform: ReturnType<typeof openPlatformDb>;
  readonly config: ServerConfig;
  readonly jobs: JobRegistry;
  readonly owner: (req: FastifyRequest) => Account;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** `openProject` of `app.ts`: answers 404/403 itself and returns null. */
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ReturnType<typeof openProjectDb>; path: string; owner: Account } | null;
  readonly adapterFor?: AdapterFor;
}

export function registerDraftRoutes(app: FastifyInstance, deps: DraftRouteDeps): void {
  const { platform, config, jobs } = deps;

  const adapterFor = deps.adapterFor ?? defaultAdapterFor(config);

  app.post<{ Params: { name: string } }>(
    '/api/projects/:name/draft',
    async (req, reply) => {
      const me = deps.owner(req);
      if (me.role !== 'owner') {
        return reply.code(403).send({ error: 'only an owner can do that' });
      }
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      let decision;
      try {
        decision = engineFor(platform, opened.owner.id, opened.db);
      } finally {
        opened.db.close();
      }
      if (decision.engine === 'off') {
        return reply.code(409).send({
          error: 'no draft engine is switched on for this project',
          reason: decision.reason,
        });
      }
      const adapter = adapterFor(decision.engine);
      if (!adapter) {
        return reply
          .code(503)
          .send({ error: 'the draft engine is not configured on this server' });
      }
      if (jobs.runningFor(me.id, 'draft') >= 1) {
        return reply
          .code(409)
          .send({ error: 'a drafting run is already going — wait for it, or cancel it' });
      }
      if (jobs.running() >= MAX_RUNNING_JOBS) {
        return reply
          .code(503)
          .send({ error: 'the server is busy with other jobs — try again shortly' });
      }

      const handle = startDraftRun({
        platform,
        ownerId: opened.owner.id,
        projectPath: opened.path,
        adapter,
        actor: deps.sessionActor(req),
      });
      const job = jobs.start({
        accountId: me.id,
        kind: 'draft',
        tm: req.params.name,
        handle,
        onSettled: (outcome) => {
          if ('failure' in outcome) {
            // A message may name a file on this server: the client gets a fixed one (§2.5).
            app.log.error({ err: outcome.failure }, 'drafting run failed');
            return { state: 'failed', error: 'the drafting run failed' };
          }
          if (outcome.status === 'cancelled') return { state: 'cancelled' };
          return { state: 'done', result: outcome.value };
        },
      });
      return reply.code(202).header('location', `/api/jobs/${job.id}`).send({ job });
    },
  );
}
