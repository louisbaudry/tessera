/**
 * The API server (v1-spec.md §2.5; backlog #27).
 *
 * `@cat-tool/core` and `@cat-tool/db` run in this process only — the
 * browser never touches SQLite. One bearer-session login gate in front
 * of everything under `/api/` except `POST /api/login`, the same
 * mechanism as the portal's admin (`portal-v0-spec.md` §7) because it is
 * the same problem; and every file path is built from the authenticated
 * account's storage root (`storage.ts`), never from the request.
 *
 * Each route is one or two repository calls with HTTP around them, the
 * discipline the CLI set (§2.4): logic the server would need that
 * `core`/`db` lack goes there, not here.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  assembleFile,
  attachmentDisposition,
  generateSessionToken,
  parseTokens,
  rulesFor,
  SdltmError,
  SegmentEditError,
  TmxError,
  TokenShapeError,
  verifyPassword,
  type AuditActor,
  type Project,
  type SegmenterRules,
} from '@cat-tool/core';
import {
  addTmRef,
  createAccountSession,
  createProject,
  createTm,
  describeTm,
  deleteAccountSession,
  confirmEditedSegment,
  dismissQaIssue,
  ConfirmError,
  editSegmentTarget,
  exportFile,
  getAccountByEmail,
  getAccountBySessionToken,
  getFileSummary,
  getProject,
  getSegment,
  importSdltm,
  importTmxFile,
  insertFile,
  isQaRule,
  listFileQaIssues,
  listFileSummaries,
  listSegments,
  listTmRefs,
  mergeSegmentWithNext,
  nextTmPriority,
  openPlatformDb,
  openProjectDb,
  openTm,
  pretranslate,
  ProjectExportError,
  QaIssueError,
  recordDownload,
  recordFailedLogin,
  recordProjectChange,
  reinstateQaIssue,
  removeTmRef,
  reorderTmRefs,
  SegmentRepoError,
  setWriteTarget,
  splitSegmentAt,
  TargetConflictError,
  TargetStructureError,
  TmError,
  TmRefError,
  type Account,
} from '@cat-tool/db';
import multipart from '@fastify/multipart';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';

import type { ServerConfig } from './config.js';
import {
  InvalidNameError,
  listProjectNames,
  listTmSlugs,
  projectPath,
  tmPath,
  tmSlugOf,
  uploadTempPath,
} from './storage.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook for every authenticated `/api/` request; null before it. */
    account: Account | null;
  }
}

export interface BuildAppOptions {
  readonly config: ServerConfig;
  /**
   * Off in tests; a running server logs every request. Method, URL and
   * status only — never a body, which may be segment text
   * (audit-spec.md §5; a test pins it).
   */
  readonly logger?: FastifyServerOptions['logger'];
}

/**
 * The account the gate authenticated. Every `/api/` handler but login
 * runs behind the gate, so this never throws in practice; it exists so
 * a handler never reads a nullable field it cannot explain.
 */
function owner(req: FastifyRequest): Account {
  if (!req.account) throw new Error('request reached a handler without passing the gate');
  return req.account;
}

/** The login route is the one `/api/` path the gate lets through. */
const LOGIN_PATH = '/api/login';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * A memory upload streams to disk, never into a buffer, so it may be
 * larger than a document: an agency's TMX or `.sdltm` runs to hundreds
 * of megabytes (tm-format-spec.md §11).
 */
const MAX_TM_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Written into a memory the server creates (tm-format-spec.md §2.1). */
const TM_GENERATOR = 'cat-tool/server';

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

/**
 * The session's account as an audit actor (audit-spec.md §2.1), its
 * email snapshotted as the label so the record still reads after the
 * account is gone. The one place a route's actor is built (spec §2.5):
 * every handler behind the gate passes `sessionActor(req)` to the write
 * it wraps.
 */
function auditActor(account: Account): AuditActor {
  return { actor: { kind: 'account', id: account.id }, label: account.email };
}

const sessionActor = (req: FastifyRequest): AuditActor => auditActor(owner(req));

/**
 * A refused login has no authenticated principal: the gate that refused
 * it is the actor, never the account the request named (spec §2.5).
 */
const LOGIN_GATE: AuditActor = { actor: { kind: 'system', name: 'login' }, label: null };

const DOCX_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What a client sees of an account: never the password hash or the storage root. */
function publicAccount(account: Account) {
  return { id: account.id, email: account.email, createdAt: account.createdAt };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const platform = openPlatformDb(config.dbPath);

  const app = Fastify({ logger: options.logger ?? true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  app.decorateRequest('account', null);

  app.addHook('onClose', () => {
    platform.close();
  });

  // --- the login gate ------------------------------------------------

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/') || path === LOGIN_PATH) return;
    const token = bearerToken(req);
    const account = token === null ? null : getAccountBySessionToken(platform, token);
    if (!account) {
      return reply.code(401).send({ error: 'invalid, missing, or expired session' });
    }
    req.account = account;
  });

  app.post<{ Body: { email?: string; password?: string } }>(
    LOGIN_PATH,
    async (req, reply) => {
      const { email, password } = req.body ?? {};
      const account = email ? getAccountByEmail(platform, email) : null;
      if (!account || !password || !verifyPassword(password, account.passwordHash)) {
        // Told apart in the log, never in the response.
        recordFailedLogin(platform, {
          actor: LOGIN_GATE,
          accountId: account?.id ?? null,
          reason: account ? 'wrong_password' : 'unknown_email',
        });
        return reply.code(401).send({ error: 'invalid email or password' });
      }
      const token = generateSessionToken();
      const { expiresAt } = createAccountSession(platform, account.id, token, {
        actor: auditActor(account),
      });
      return { token, expiresAt, account: publicAccount(account) };
    },
  );

  app.post('/api/logout', async (req) => {
    const token = bearerToken(req);
    if (token !== null)
      deleteAccountSession(platform, token, { actor: sessionActor(req) });
    return { ok: true };
  });

  app.get('/api/me', async (req) => publicAccount(owner(req)));

  // --- projects: one `.catdb` each, under the account's root ----------

  /**
   * Resolves a project name to an open database, or answers the request
   * with the right refusal. The name is validated before any path is
   * built; a project the account does not have is a 404 whether or not
   * another account has one by that name.
   */
  function openOwnProject(
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
  ): { db: ReturnType<typeof openProjectDb>; project: Project; path: string } | null {
    let path: string;
    try {
      path = projectPath(config.storageRoot, owner(req), name);
    } catch (err) {
      if (err instanceof InvalidNameError) {
        void reply.code(400).send({ error: err.message });
        return null;
      }
      throw err;
    }
    if (!existsSync(path)) {
      void reply.code(404).send({ error: `no project named "${name}"` });
      return null;
    }
    const db = openProjectDb(path);
    const project = getProject(db);
    if (!project) {
      db.close();
      void reply.code(500).send({ error: `project "${name}" has no identity row` });
      return null;
    }
    return { db, project, path };
  }

  app.get('/api/projects', async (req) => {
    const account = owner(req);
    return listProjectNames(config.storageRoot, account).map((name) => {
      const db = openProjectDb(projectPath(config.storageRoot, account, name));
      try {
        return {
          name,
          project: getProject(db),
          fileCount: listFileSummaries(db).length,
        };
      } finally {
        db.close();
      }
    });
  });

  // `writeTm` names the memory the project's confirmed segments go to
  // (v1-spec.md §7.5): attached first, as the write target, and created
  // empty if the account has no memory by that name. Without one,
  // confirming refuses until a write target is chosen.
  app.post<{
    Body: {
      name?: string;
      srcLang?: string;
      tgtLang?: string;
      title?: string;
      writeTm?: unknown;
    };
  }>('/api/projects', async (req, reply) => {
    const { name, srcLang, tgtLang, title, writeTm } = req.body ?? {};
    if (!name || !srcLang || !tgtLang) {
      return reply.code(400).send({ error: 'name, srcLang and tgtLang are required' });
    }
    if (writeTm !== undefined && typeof writeTm !== 'string') {
      return reply.code(400).send({ error: 'writeTm must be a memory name' });
    }
    let path: string;
    let memory: string | null;
    try {
      path = projectPath(config.storageRoot, owner(req), name);
      memory = writeTm ? tmPath(config.storageRoot, owner(req), writeTm) : null;
    } catch (err) {
      if (err instanceof InvalidNameError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    if (existsSync(path)) {
      return reply.code(409).send({ error: `a project named "${name}" already exists` });
    }
    const actor = sessionActor(req);
    const project = recordProjectChange(
      platform,
      'project.created',
      { actor, project: { accountId: owner(req).id, name } },
      () => {
        mkdirSync(dirname(path), { recursive: true });
        const db = openProjectDb(path);
        try {
          const created = createProject(db, { name: title ?? name, srcLang, tgtLang });
          if (memory !== null && writeTm) {
            if (!existsSync(memory)) {
              mkdirSync(dirname(memory), { recursive: true });
              createTm(memory, { name: writeTm, generator: TM_GENERATOR }).close();
            }
            addTmRef(db, { path: memory, priority: 1, isWriteTarget: true, actor });
          }
          return created;
        } finally {
          db.close();
        }
      },
    );
    return reply.code(201).send({ name, project, fileCount: 0 });
  });

  // Deleting a project deletes its file, and with it the project's own
  // log; `platform.sqlite` keeps that it happened (spec §5).
  app.delete<{ Params: { name: string } }>('/api/projects/:name', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db, path } = opened;
    db.close();
    recordProjectChange(
      platform,
      'project.deleted',
      {
        actor: sessionActor(req),
        project: { accountId: owner(req).id, name: req.params.name },
      },
      () => {
        for (const suffix of ['', '-wal', '-shm'])
          rmSync(`${path}${suffix}`, { force: true });
      },
    );
    return reply.code(204).send();
  });

  app.get<{ Params: { name: string } }>('/api/projects/:name', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db, project } = opened;
    try {
      return {
        name: req.params.name,
        project,
        files: listFileSummaries(db),
      };
    } finally {
      db.close();
    }
  });

  // One DOCX per request, multipart; its filename is the `rel_path`
  // unless a `relPath` field says otherwise. `assembleFile` +
  // `insertFile`, exactly the CLI's `add-file`.
  app.post<{ Params: { name: string } }>(
    '/api/projects/:name/files',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db, project } = opened;
      try {
        const part = await req.file();
        if (!part) {
          return reply.code(400).send({ error: 'a DOCX file part is required' });
        }
        const bytes = new Uint8Array(await part.toBuffer());
        const relPathField = part.fields['relPath'];
        const relPath =
          relPathField && !Array.isArray(relPathField) && relPathField.type === 'field'
            ? String(relPathField.value)
            : part.filename;

        let rules: SegmenterRules;
        try {
          rules = rulesFor(project.srcLang);
        } catch (err) {
          return reply.code(422).send({
            error: `cannot segment ${project.srcLang}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        const assembled = assembleFile(bytes, rules);
        let fileId: number;
        try {
          fileId = insertFile(db, relPath, assembled, { actor: sessionActor(req) }).id;
        } catch (err) {
          if (
            err instanceof Error &&
            /UNIQUE constraint failed: file\.rel_path/.test(err.message)
          ) {
            return reply
              .code(409)
              .send({ error: `a file named "${relPath}" is already in this project` });
          }
          throw err;
        }
        return reply.code(201).send({
          file: getFileSummary(db, fileId),
          locked: assembled.segments.filter((s) => s.locked).length,
        });
      } finally {
        db.close();
      }
    },
  );

  app.get<{ Params: { name: string; fileId: string } }>(
    '/api/projects/:name/files/:fileId/segments',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db } = opened;
      try {
        const fileId = Number(req.params.fileId);
        const file = Number.isInteger(fileId) ? getFileSummary(db, fileId) : null;
        if (!file) {
          return reply.code(404).send({ error: `no file #${req.params.fileId}` });
        }
        return { file, segments: listSegments(db, fileId) };
      } finally {
        db.close();
      }
    },
  );

  // Every QA issue on the file's segments, dismissed ones included: the
  // grid's gutter hides those, the QA panel (#33) lists them (spec §7.1).
  app.get<{ Params: { name: string; fileId: string } }>(
    '/api/projects/:name/files/:fileId/qa-issues',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db } = opened;
      try {
        const fileId = Number(req.params.fileId);
        const file = Number.isInteger(fileId) ? getFileSummary(db, fileId) : null;
        if (!file) {
          return reply.code(404).send({ error: `no file #${req.params.fileId}` });
        }
        return { issues: listFileQaIssues(db, fileId) };
      } finally {
        db.close();
      }
    },
  );

  // The delivered DOCX: `exportFile`, exactly the CLI's `export`. The
  // project's log records it produced (`project.exported`); this file's
  // records it left, to whom (`file.downloaded`) — before the first byte.
  app.get<{ Params: { name: string; fileId: string } }>(
    '/api/projects/:name/files/:fileId/export',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db } = opened;
      const actor = sessionActor(req);
      let exported: ReturnType<typeof exportFile>;
      try {
        const fileId = Number(req.params.fileId);
        if (!Number.isInteger(fileId)) {
          return reply.code(404).send({ error: `no file #${req.params.fileId}` });
        }
        exported = exportFile(db, fileId, { actor });
      } catch (err) {
        if (err instanceof ProjectExportError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      } finally {
        db.close();
      }
      const name = exported.file.relPath.split(/[\\/]/).pop() || exported.file.relPath;
      recordDownload(platform, {
        actor,
        project: { accountId: owner(req).id, name: req.params.name },
        fileId: exported.file.id,
        name: exported.file.relPath,
        sha256: exported.sha256,
      });
      return reply
        .header('content-type', DOCX_TYPE)
        .header('content-disposition', attachmentDisposition(name))
        .send(Buffer.from(exported.bytes));
    },
  );

  // One segment's target, as the translator left it: `editSegmentTarget`
  // with the session's actor, so the edit lands in the *project's* log
  // (spec decision 5). The body is what the translator placed — text and
  // visible tags — and the segment version the editor saw; what it means
  // (hidden tags carried, status, origin, whether anything changed, QA)
  // is db's to decide (v1-spec.md §7.2), and a client's say in status or
  // origin is refused rather than ignored.
  app.put<{
    Params: { name: string; segmentId: string };
    Body: {
      targetTokens?: unknown;
      baseUpdatedAt?: unknown;
      status?: unknown;
      origin?: unknown;
    };
  }>('/api/projects/:name/segments/:segmentId', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db } = opened;
    try {
      const id = Number(req.params.segmentId);
      const segment = Number.isInteger(id) ? getSegment(db, id) : null;
      if (!segment) {
        return reply.code(404).send({ error: `no segment #${req.params.segmentId}` });
      }
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'the body must be a JSON object' });
      }
      if ('status' in body || 'origin' in body) {
        return reply.code(400).send({
          error: "status and origin are the server's: an edit is its translator's own",
        });
      }
      const { targetTokens, baseUpdatedAt } = body;
      if (targetTokens === undefined) {
        return reply.code(400).send({ error: 'targetTokens is required (null clears)' });
      }
      if (baseUpdatedAt !== undefined && typeof baseUpdatedAt !== 'string') {
        return reply.code(400).send({ error: 'baseUpdatedAt must be a string' });
      }
      let tokens;
      try {
        tokens =
          targetTokens === null ? [] : parseTokens(targetTokens, segment.formatTable);
      } catch (err) {
        if (err instanceof TokenShapeError) {
          return reply.code(400).send({ error: `targetTokens: ${err.message}` });
        }
        throw err;
      }
      try {
        return editSegmentTarget(db, id, {
          tokens,
          actor: sessionActor(req),
          baseUpdatedAt,
        });
      } catch (err) {
        if (err instanceof TargetConflictError) {
          return reply.code(409).send({ error: err.message, segment: err.current });
        }
        if (err instanceof TargetStructureError) {
          return reply.code(400).send({ error: `targetTokens: ${err.message}` });
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

  // The translator's confirm of one segment: `confirmEditedSegment` with
  // the session's actor (v1-spec.md §7.3). It approves the stored target
  // at the version the editor saw, so the client's own writes go first
  // (the save queue orders them); what confirming means — the memory's
  // write-back, the audit event, QA — is db's.
  app.post<{
    Params: { name: string; segmentId: string };
    Body: { baseUpdatedAt?: unknown };
  }>('/api/projects/:name/segments/:segmentId/confirm', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db } = opened;
    try {
      const id = Number(req.params.segmentId);
      if (!Number.isInteger(id) || !getSegment(db, id)) {
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
        return confirmEditedSegment(db, id, { actor: sessionActor(req), baseUpdatedAt });
      } catch (err) {
        if (err instanceof TargetConflictError) {
          return reply.code(409).send({ error: err.message, segment: err.current });
        }
        if (err instanceof ConfirmError || err instanceof SegmentRepoError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    } finally {
      db.close();
    }
  });

  // A finding set aside, or counted again (backlog #33, spec §6.4):
  // `dismissQaIssue`/`reinstateQaIssue` with the session's actor, so the
  // decision lands in the project's log. The finding is named by its
  // segment and rule, which a rerun keeps, never by its row id, which a
  // rerun replaces — a dismissal sent while a save of the segment is
  // landing still finds it. One already in the asked state is a no-op.
  app.put<{
    Params: { name: string; segmentId: string; rule: string };
    Body: { dismissed?: unknown };
  }>('/api/projects/:name/segments/:segmentId/qa-issues/:rule', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db } = opened;
    try {
      const segmentId = Number(req.params.segmentId);
      const { rule } = req.params;
      if (!Number.isInteger(segmentId) || !isQaRule(rule)) {
        return reply.code(404).send({
          error: `no ${req.params.rule} finding on segment #${req.params.segmentId}`,
        });
      }
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'the body must be a JSON object' });
      }
      if (typeof body.dismissed !== 'boolean') {
        return reply.code(400).send({ error: 'dismissed must be true or false' });
      }
      const write = body.dismissed ? dismissQaIssue : reinstateQaIssue;
      try {
        return { issue: write(db, { segmentId, rule }, { actor: sessionActor(req) }) };
      } catch (err) {
        if (err instanceof QaIssueError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    } finally {
      db.close();
    }
  });

  // Merge and split (v1-spec.md §7.4): `splitSegmentAt` and
  // `mergeSegmentWithNext` with the session's actor. The body carries the
  // versions the editor saw (a stale one is a 409, as for an edit) and,
  // for a split, the plain-text offset into the source; what happens to
  // rows, targets, hashes, the log and QA is db's. The answer names the
  // segments now standing and the ones gone, so the grid can re-key.
  app.post<{
    Params: { name: string; segmentId: string };
    Body: { offset?: unknown; baseUpdatedAt?: unknown };
  }>('/api/projects/:name/segments/:segmentId/split', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db } = opened;
    try {
      const id = Number(req.params.segmentId);
      if (!Number.isInteger(id) || !getSegment(db, id)) {
        return reply.code(404).send({ error: `no segment #${req.params.segmentId}` });
      }
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'the body must be a JSON object' });
      }
      const { offset, baseUpdatedAt } = body;
      if (typeof offset !== 'number' || !Number.isInteger(offset)) {
        return reply.code(400).send({ error: 'offset must be an integer' });
      }
      if (baseUpdatedAt !== undefined && typeof baseUpdatedAt !== 'string') {
        return reply.code(400).send({ error: 'baseUpdatedAt must be a string' });
      }
      try {
        return splitSegmentAt(db, id, {
          offset,
          actor: sessionActor(req),
          baseUpdatedAt,
        });
      } catch (err) {
        if (err instanceof TargetConflictError) {
          return reply.code(409).send({ error: err.message, segment: err.current });
        }
        if (err instanceof SegmentEditError) {
          return reply.code(400).send({ error: err.message });
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

  app.post<{
    Params: { name: string; segmentId: string };
    Body: { baseUpdatedAt?: unknown; nextBaseUpdatedAt?: unknown };
  }>('/api/projects/:name/segments/:segmentId/merge', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db } = opened;
    try {
      const id = Number(req.params.segmentId);
      if (!Number.isInteger(id) || !getSegment(db, id)) {
        return reply.code(404).send({ error: `no segment #${req.params.segmentId}` });
      }
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'the body must be a JSON object' });
      }
      const { baseUpdatedAt, nextBaseUpdatedAt } = body;
      for (const [key, value] of Object.entries({ baseUpdatedAt, nextBaseUpdatedAt })) {
        if (value !== undefined && typeof value !== 'string') {
          return reply.code(400).send({ error: `${key} must be a string` });
        }
      }
      try {
        return mergeSegmentWithNext(db, id, {
          actor: sessionActor(req),
          baseUpdatedAt: baseUpdatedAt as string | undefined,
          nextBaseUpdatedAt: nextBaseUpdatedAt as string | undefined,
        });
      } catch (err) {
        if (err instanceof TargetConflictError) {
          return reply.code(409).send({ error: err.message, segment: err.current });
        }
        if (err instanceof SegmentEditError) {
          return reply.code(400).send({ error: err.message });
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

  // --- memories: one `.ctm` each, the account's, attached to projects --

  /** One memory as the API shows it: its slug, never its path. */
  function memorySummary(slug: string, path: string) {
    const tm = openTm(path);
    try {
      return { slug, ...describeTm(tm) };
    } finally {
      tm.close();
    }
  }

  app.get('/api/tms', async (req) => {
    const account = owner(req);
    return listTmSlugs(config.storageRoot, account).map((slug) =>
      memorySummary(slug, tmPath(config.storageRoot, account, slug)),
    );
  });

  // A memory is created empty from JSON `{ name }`, or from an upload: a
  // multipart `name` field, then one `.tmx` or `.sdltm` file, imported
  // into a new memory by that name — the CLI's `add-tm`, minus attaching.
  // The upload streams to a server-named file under the account's root
  // and is deleted after; an import that fails leaves no memory behind.
  app.post<{ Body: { name?: unknown } }>('/api/tms', async (req, reply) => {
    const account = owner(req);
    const slugOf = (value: unknown): string | null => {
      if (typeof value !== 'string' || value === '') {
        void reply.code(400).send({ error: 'a memory name is required' });
        return null;
      }
      return value;
    };
    const claim = (slug: string): string | null => {
      let path: string;
      try {
        path = tmPath(config.storageRoot, account, slug);
      } catch (err) {
        if (err instanceof InvalidNameError) {
          void reply.code(400).send({ error: err.message });
          return null;
        }
        throw err;
      }
      if (existsSync(path)) {
        void reply.code(409).send({ error: `a memory named "${slug}" already exists` });
        return null;
      }
      mkdirSync(dirname(path), { recursive: true });
      return path;
    };

    if (!req.isMultipart()) {
      const slug = slugOf(req.body?.name);
      if (slug === null) return reply;
      const path = claim(slug);
      if (path === null) return reply;
      createTm(path, { name: slug, generator: TM_GENERATOR }).close();
      return reply.code(201).send({ ...memorySummary(slug, path), warnings: [] });
    }

    const part = await req.file({ limits: { fileSize: MAX_TM_UPLOAD_BYTES } });
    if (!part) {
      return reply.code(400).send({ error: 'a .tmx or .sdltm file part is required' });
    }
    const nameField = part.fields['name'];
    const slug = slugOf(
      nameField && !Array.isArray(nameField) && nameField.type === 'field'
        ? nameField.value
        : undefined,
    );
    if (slug === null) {
      part.file.resume();
      return reply;
    }
    const ext = extname(part.filename).toLowerCase();
    if (ext !== '.tmx' && ext !== '.sdltm') {
      part.file.resume();
      return reply
        .code(415)
        .send({ error: `unsupported memory format "${ext}" — expected .tmx or .sdltm` });
    }
    const path = claim(slug);
    if (path === null) {
      part.file.resume();
      return reply;
    }
    const upload = uploadTempPath(config.storageRoot, account);
    mkdirSync(dirname(upload), { recursive: true });
    try {
      await pipeline(part.file, createWriteStream(upload));
      if (part.file.truncated) {
        return reply.code(413).send({ error: 'the memory file is too large' });
      }
      const tm = createTm(path, { name: slug, generator: TM_GENERATOR });
      let warnings: readonly string[];
      try {
        warnings = (
          ext === '.tmx'
            ? importTmxFile(tm, upload, { sourceName: part.filename })
            : importSdltm(tm, upload)
        ).warnings;
      } catch (err) {
        tm.close();
        rmSync(path, { force: true });
        if (
          err instanceof TmError ||
          err instanceof TmxError ||
          err instanceof SdltmError
        ) {
          return reply.code(422).send({ error: err.message });
        }
        throw err;
      }
      tm.close();
      return reply.code(201).send({ ...memorySummary(slug, path), warnings });
    } finally {
      rmSync(upload, { force: true });
    }
  });

  /** A project's attached memories as the API shows them: slugs, never paths. */
  function tmRefsView(req: FastifyRequest, db: ReturnType<typeof openProjectDb>) {
    return listTmRefs(db).map((ref) => ({
      id: ref.id,
      tm: tmSlugOf(config.storageRoot, owner(req), ref.path),
      priority: ref.priority,
      writeTarget: ref.isWriteTarget,
      enabled: ref.enabled,
    }));
  }

  /** A tm_ref id from the URL that names one of this project's references. */
  function refIdOf(
    reply: FastifyReply,
    db: ReturnType<typeof openProjectDb>,
    raw: string,
  ): number | null {
    const id = Number(raw);
    if (!Number.isInteger(id) || !listTmRefs(db).some((r) => r.id === id)) {
      void reply.code(404).send({ error: `no attached memory #${raw}` });
      return null;
    }
    return id;
  }

  app.get<{ Params: { name: string } }>('/api/projects/:name/tms', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    try {
      return { refs: tmRefsView(req, opened.db) };
    } finally {
      opened.db.close();
    }
  });

  // Attaches one of the account's memories after every one already there
  // (`addTmRef`), optionally as the write target.
  app.post<{ Params: { name: string }; Body: { tm?: unknown; writeTarget?: unknown } }>(
    '/api/projects/:name/tms',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db } = opened;
      try {
        const { tm, writeTarget } = req.body ?? {};
        if (typeof tm !== 'string') {
          return reply.code(400).send({ error: 'tm must be a memory name' });
        }
        if (writeTarget !== undefined && typeof writeTarget !== 'boolean') {
          return reply.code(400).send({ error: 'writeTarget must be a boolean' });
        }
        let path: string;
        try {
          path = tmPath(config.storageRoot, owner(req), tm);
        } catch (err) {
          if (err instanceof InvalidNameError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
        }
        if (!existsSync(path)) {
          return reply.code(404).send({ error: `no memory named "${tm}"` });
        }
        if (listTmRefs(db).some((r) => r.path === path)) {
          return reply
            .code(409)
            .send({ error: `memory "${tm}" is already attached to this project` });
        }
        addTmRef(db, {
          path,
          priority: nextTmPriority(db),
          isWriteTarget: writeTarget ?? false,
          actor: sessionActor(req),
        });
        return reply.code(201).send({ refs: tmRefsView(req, db) });
      } finally {
        db.close();
      }
    },
  );

  // The consultation order, first consulted first: every attached
  // memory's ref id exactly once (`reorderTmRefs`).
  app.put<{ Params: { name: string }; Body: { order?: unknown } }>(
    '/api/projects/:name/tms',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db } = opened;
      try {
        const { order } = req.body ?? {};
        if (!Array.isArray(order) || !order.every((id) => Number.isInteger(id))) {
          return reply.code(400).send({ error: 'order must be a list of ref ids' });
        }
        try {
          reorderTmRefs(db, order as number[], { actor: sessionActor(req) });
        } catch (err) {
          if (err instanceof TmRefError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
        }
        return { refs: tmRefsView(req, db) };
      } finally {
        db.close();
      }
    },
  );

  app.post<{ Params: { name: string; refId: string } }>(
    '/api/projects/:name/tms/:refId/write-target',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db } = opened;
      try {
        const id = refIdOf(reply, db, req.params.refId);
        if (id === null) return reply;
        setWriteTarget(db, id, { actor: sessionActor(req) });
        return { refs: tmRefsView(req, db) };
      } finally {
        db.close();
      }
    },
  );

  // Detaching leaves the memory itself alone: it may serve other projects.
  app.delete<{ Params: { name: string; refId: string } }>(
    '/api/projects/:name/tms/:refId',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      const { db } = opened;
      try {
        const id = refIdOf(reply, db, req.params.refId);
        if (id === null) return reply;
        removeTmRef(db, id, { actor: sessionActor(req) });
        return { refs: tmRefsView(req, db) };
      } finally {
        db.close();
      }
    },
  );

  // The exact matcher over the whole project (v1-spec.md §6.1), exactly
  // the CLI's `pretranslate`: one `project.pretranslate` in the project's
  // log, its counts the answer.
  app.post<{ Params: { name: string } }>(
    '/api/projects/:name/pretranslate',
    async (req, reply) => {
      const opened = openOwnProject(req, reply, req.params.name);
      if (!opened) return reply;
      try {
        return pretranslate(opened.db, { actor: sessionActor(req) });
      } finally {
        opened.db.close();
      }
    },
  );

  return app;
}
