/**
 * Find and replace across a project (`v1-spec.md` §7.8; backlog #148b, issue #170):
 * two routes that each start a bulk job, the preview and the apply. Both are the
 * project owner's (`manage`): a project-wide rewrite is not something a translator
 * on a grant runs.
 *
 * **They are jobs because a pattern can hang a thread.** A regular expression with
 * nested quantifiers takes exponential time, which no validation rules out, so the
 * work runs on a worker thread (`project.replaceScan`, `project.replaceApply`) and
 * the thread is terminated at a time limit: the scan's `REPLACE_TIME_LIMIT_MS`, the
 * apply's longer `REPLACE_APPLY_TIME_LIMIT_MS` (it also writes). An apply is one
 * transaction, so a terminated one changes nothing, and the answer says so.
 *
 * The client polls `GET /api/jobs/:id` as for any job. The pattern and the
 * replacement never reach a log or an error message: they are the owner's own words
 * and may carry a client's.
 */

import {
  findProblem,
  REPLACE_APPLY_TIME_LIMIT_MS,
  REPLACE_MAX_SEGMENTS,
  REPLACE_TIME_LIMIT_MS,
  type AuditActor,
  type FindSpec,
  type ProjectAction,
} from '@cat-tool/core';
import {
  startJob,
  type Account,
  type JobHandle,
  type openProjectDb,
  type ReplaceChoice,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { MAX_RUNNING_JOBS, type JobRegistry } from './jobs.js';

export interface ReplaceRouteDeps {
  readonly jobs: JobRegistry;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** `openProject` of `app.ts`: answers 404/403 itself and returns null. */
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ReturnType<typeof openProjectDb>; path: string; owner: Account } | null;
  /** The account a request is made as, for the registry's per-account count. */
  readonly accountId: (req: FastifyRequest) => number;
  /** Time limits in ms; `core`'s when omitted. Shortened only by a test of a hanging pattern. */
  readonly limitsMs?: { readonly scan?: number; readonly apply?: number };
}

interface Body {
  pattern?: unknown;
  replacement?: unknown;
  regex?: unknown;
  caseSensitive?: unknown;
  fileId?: unknown;
  chosen?: unknown;
}

const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** The request's pattern, replacement and scope, or the 400 text for what is wrong with them. */
function parse(
  body: Body | undefined,
): { find: FindSpec; replacement: string; fileId?: number } | { error: string } {
  const {
    pattern,
    replacement = '',
    regex = false,
    caseSensitive = false,
    fileId,
  } = body ?? {};
  if (typeof pattern !== 'string') return { error: 'pattern must be the text to find' };
  if (typeof replacement !== 'string') return { error: 'replacement must be text' };
  if (typeof regex !== 'boolean' || typeof caseSensitive !== 'boolean') {
    return { error: 'regex and caseSensitive must be booleans' };
  }
  if (fileId !== undefined && !positiveInt(fileId)) {
    return { error: 'fileId must be a file id' };
  }
  const find: FindSpec = { pattern, regex, caseSensitive };
  const problem = findProblem(find, replacement);
  if (problem !== null) return { error: problem };
  return { find, replacement, ...(fileId !== undefined ? { fileId } : {}) };
}

export function registerReplaceRoutes(
  app: FastifyInstance,
  deps: ReplaceRouteDeps,
): void {
  /**
   * Starts one job for the project and registers it with its time limit. The limit
   * ends the thread, and a job it ended says so in words that do not repeat the
   * pattern.
   */
  function start(
    req: FastifyRequest,
    reply: FastifyReply,
    project: string,
    run: () => JobHandle<unknown>,
    limitMs: number,
    kind: 'scan' | 'apply',
  ) {
    const me = deps.accountId(req);
    if (deps.jobs.runningFor(me, 'replace') >= 1) {
      return reply.code(409).send({
        error: 'a find and replace is already running: wait for it, or cancel it',
      });
    }
    if (deps.jobs.running() >= MAX_RUNNING_JOBS) {
      return reply
        .code(503)
        .send({ error: 'the server is busy with other jobs: try again shortly' });
    }
    const handle = run();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.cancel({ immediately: true });
    }, limitMs);
    void handle.done.finally(() => clearTimeout(timer)).catch(() => undefined);
    const job = deps.jobs.start({
      accountId: me,
      kind: 'replace',
      tm: project,
      handle,
      onSettled: (outcome) => {
        if ('failure' in outcome) {
          // A message may name a file on this server, or the pattern: the client gets a fixed one.
          app.log.error({ err: outcome.failure.name }, 'find and replace failed');
          return {
            state: 'failed',
            error:
              kind === 'apply'
                ? 'the replace failed and nothing was changed'
                : 'the search failed',
          };
        }
        if (outcome.status === 'cancelled') {
          if (timedOut) {
            return {
              state: 'failed',
              error:
                kind === 'apply'
                  ? 'the pattern took too long, so nothing was changed: simplify it'
                  : 'the pattern took too long: simplify it',
            };
          }
          return { state: 'cancelled' };
        }
        return { state: 'done', result: outcome.value };
      },
    });
    return reply.code(202).header('location', `/api/jobs/${job.id}`).send({ job });
  }

  // The preview: `{ pattern, replacement?, regex?, caseSensitive?, fileId? }`. The
  // job's result lists the segments a run would change, with the text before and after.
  app.post<{ Params: { name: string }; Body: Body | undefined }>(
    '/api/projects/:name/replace/scan',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const projectPath = opened.path;
      opened.db.close();
      const parsed = parse(req.body);
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
      return start(
        req,
        reply,
        req.params.name,
        () =>
          startJob('project.replaceScan', {
            projectPath,
            find: parsed.find,
            replacement: parsed.replacement,
            ...(parsed.fileId !== undefined ? { fileId: parsed.fileId } : {}),
          }),
        deps.limitsMs?.scan ?? REPLACE_TIME_LIMIT_MS,
        'scan',
      );
    },
  );

  // The run the owner kept: the same fields, and `chosen: [{ segmentId, updatedAt }]`,
  // the segments ticked in the preview with the version each had there. A segment that
  // has changed since is skipped and counted, never overwritten.
  app.post<{ Params: { name: string }; Body: Body | undefined }>(
    '/api/projects/:name/replace/apply',
    async (req, reply) => {
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const projectPath = opened.path;
      opened.db.close();
      const parsed = parse(req.body);
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
      const raw = req.body?.chosen;
      if (
        !Array.isArray(raw) ||
        raw.length === 0 ||
        !raw.every(
          (c): c is ReplaceChoice =>
            typeof c === 'object' &&
            c !== null &&
            positiveInt((c as ReplaceChoice).segmentId) &&
            typeof (c as ReplaceChoice).updatedAt === 'string',
        )
      ) {
        return reply
          .code(400)
          .send({ error: 'chosen must list segments as { segmentId, updatedAt }' });
      }
      if (raw.length > REPLACE_MAX_SEGMENTS) {
        return reply.code(400).send({
          error: `Replace in at most ${REPLACE_MAX_SEGMENTS} segments at a time.`,
        });
      }
      const chosen = raw.map((c) => ({ segmentId: c.segmentId, updatedAt: c.updatedAt }));
      const actor = deps.sessionActor(req);
      return start(
        req,
        reply,
        req.params.name,
        () =>
          startJob('project.replaceApply', {
            projectPath,
            find: parsed.find,
            replacement: parsed.replacement,
            ...(parsed.fileId !== undefined ? { fileId: parsed.fileId } : {}),
            chosen,
            actor,
          }),
        deps.limitsMs?.apply ?? REPLACE_APPLY_TIME_LIMIT_MS,
        'apply',
      );
    },
  );
}
