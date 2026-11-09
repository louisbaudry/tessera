/**
 * Live or deferred QA for a project, and the batch run that catches a deferred one up
 * (issue #361, `planning/v1-spec.md` §7.10).
 *
 * - `GET /api/projects/:name/qa-mode`: the mode and whether findings are stale (`read`).
 * - `PUT /api/projects/:name/qa-mode` `{ deferred }`: the owner's choice (`manage`). Going
 *   live again while findings are stale is a 409, because live QA would trust rows no
 *   sweep has checked.
 * - `POST /api/projects/:name/qa/sweep`: starts the sweep as a job (`manage`, like every job
 *   here: a job belongs to a tenant's staff, so a translator on a grant cannot own or poll one;
 *   the owner runs QA before reviewing). Only a deferred project sweeps (a 409 otherwise). A sweep
 *   is 6 s at 100,000 segments, so it is a job, never the request thread; one runs at a time per account.
 *
 * The gate that reads findings (review, `countBlockingQa`) refuses stale ones with a 409 of
 * its own (`assignments.ts`), which is why a deferred project cannot ship a blocking issue.
 */

import type { AuditActor, ProjectAction } from '@cat-tool/core';
import {
  isQaDeferred,
  qaUnsweptEdits,
  QaStaleError,
  setQaDeferred,
  startJob,
  type JobHandle,
  type openProjectDb,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { MAX_RUNNING_JOBS, type JobRegistry } from './jobs.js';

export interface QaModeRouteDeps {
  readonly jobs: JobRegistry;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** `openProject` of `app.ts`: answers 404/403 itself and returns null. */
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ReturnType<typeof openProjectDb>; path: string; tenant: Tenant } | null;
  /** The account a request is made as, for the registry's per-account count. */
  readonly tenantId: (req: FastifyRequest) => number;
}

/** What the page needs to show: the mode, and whether the findings it lists can be trusted. */
interface QaModeView {
  readonly deferred: boolean;
  readonly stale: boolean;
  readonly unsweptEdits: number;
}

export function registerQaModeRoutes(app: FastifyInstance, deps: QaModeRouteDeps): void {
  app.get<{ Params: { name: string } }>(
    '/api/projects/:name/qa-mode',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'read');
      if (!opened) return reply;
      try {
        const unsweptEdits = qaUnsweptEdits(opened.db);
        const view: QaModeView = {
          deferred: isQaDeferred(opened.db),
          stale: unsweptEdits > 0,
          unsweptEdits,
        };
        return view;
      } finally {
        opened.db.close();
      }
    },
  );

  app.put<{ Params: { name: string }; Body: { deferred?: unknown } | undefined }>(
    '/api/projects/:name/qa-mode',
    async (req, reply) => {
      // The project first: a missing one is a 404 whatever the body, so the body proves nothing about it.
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        const deferred = req.body?.deferred;
        if (typeof deferred !== 'boolean') {
          return reply.code(400).send({ error: 'deferred must be true or false' });
        }
        setQaDeferred(opened.db, deferred, deps.sessionActor(req));
        const unsweptEdits = qaUnsweptEdits(opened.db);
        const view: QaModeView = {
          deferred: isQaDeferred(opened.db),
          stale: unsweptEdits > 0,
          unsweptEdits,
        };
        return view;
      } catch (err) {
        if (err instanceof QaStaleError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      } finally {
        opened.db.close();
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/projects/:name/qa/sweep',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const projectPath = opened.path;
      // A live project keeps its findings current on every edit, and a sweep over its snapshot
      // of the siblings could overwrite what an edit made meanwhile: only a deferred one sweeps.
      const deferred = isQaDeferred(opened.db);
      opened.db.close();
      if (!deferred) {
        return reply.code(409).send({
          error: 'QA runs on every edit in this project: there is nothing to run',
        });
      }
      const me = deps.tenantId(req);
      if (deps.jobs.runningFor(me, 'qa') >= 1) {
        return reply
          .code(409)
          .send({ error: 'QA is already running: wait for it to finish' });
      }
      if (deps.jobs.running() >= MAX_RUNNING_JOBS) {
        return reply
          .code(503)
          .send({ error: 'the server is busy with other jobs: try again shortly' });
      }
      const handle: JobHandle<unknown> = startJob('project.qaSweep', { projectPath });
      const job = deps.jobs.start({
        tenantId: me,
        kind: 'qa',
        tm: req.params.name,
        handle,
        onSettled: (outcome) => {
          if ('failure' in outcome) {
            // A message may name a file on this server: the client gets a fixed one.
            app.log.error({ err: outcome.failure.name }, 'qa sweep failed');
            return { state: 'failed', error: 'the QA run failed: try again' };
          }
          if (outcome.status === 'cancelled') return { state: 'cancelled' };
          return { state: 'done', result: outcome.value };
        },
      });
      return reply.code(202).header('location', `/api/jobs/${job.id}`).send({ job });
    },
  );
}
