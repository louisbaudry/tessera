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
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  assembleFile,
  attachmentDisposition,
  DEFAULT_FUZZY_THRESHOLD,
  findMismatches,
  FUZZY_FLOOR,
  FUZZY_MAX_SCORE,
  formatActor,
  generateSessionToken,
  isFuzzyThreshold,
  isSlug,
  parseTokens,
  primarySubtag,
  rulesFor,
  scopeAllows,
  GlossarySessionError,
  SegmentEditError,
  TokenShapeError,
  UnsupportedGlossaryLanguage,
  verifyPassword,
  type AuditActor,
  type Project,
  type ProjectAction,
  type SegmenterRules,
} from '@cat-tool/core';
import {
  acceptExceptionProposal,
  addGlossaryRef,
  addTmRef,
  commitGlossarySession,
  createAccountSession,
  createGlossary,
  createProject,
  createTm,
  deleteAccountSession,
  confirmEditedSegment,
  dismissQaIssue,
  ConfirmError,
  editSegmentTarget,
  exportFile,
  getAccountByEmail,
  getAccountById,
  getAccountBySessionToken,
  getFileSummary,
  getProject,
  FUZZY_THRESHOLD_MESSAGE,
  getFuzzyThreshold,
  getSegment,
  insertFile,
  isQaRule,
  JobError,
  listFileQaIssues,
  listGlossaryRefs,
  listExceptionProposals,
  listTermEntries,
  listVariants,
  listFileSummaries,
  listSegments,
  listTmRefs,
  mergeSegmentWithNext,
  nextGlossaryPriority,
  nextTmPriority,
  openGlossary,
  openPlatformDb,
  openProjectDb,
  peekTm,
  pretranslate,
  ProjectExportError,
  QaIssueError,
  recordDownload,
  recordFailedLogin,
  recordProjectChange,
  revokeAllProjectAuthorizations,
  scopeOf,
  reinstateQaIssue,
  removeTmRef,
  reorderTmRefs,
  SegmentRepoError,
  setFuzzyThreshold,
  setGlossaryWriteTarget,
  setWriteTarget,
  splitSegmentAt,
  startJob,
  TargetConflictError,
  TargetStructureError,
  recordSegmentException,
  TermError,
  TmRefError,
  type Account,
  type TmSummary,
} from '@cat-tool/db';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';

import type { ServerConfig } from './config.js';
import {
  sessionKey,
  sessionView,
  startGlossarySession,
  type HeldSession,
} from './glossary-session.js';
import { registerAssignmentRoutes } from './assignments.js';
import {
  ACCEPT_INVITATION_PATH,
  OPEN_INVITATION_PATH,
  registerInvitationRoutes,
} from './invitations.js';
import { JobRegistry, MAX_RUNNING_JOBS } from './jobs.js';
import {
  glossaryPath,
  glossarySlugOf,
  InvalidNameError,
  listGlossarySlugs,
  listProjectNames,
  listTmSlugs,
  projectPath,
  sweepUploadTemp,
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

const LOGIN_PATH = '/api/login';

/**
 * The only `/api/` paths answered without a session: logging in, and the two steps
 * an invitee takes before they have an account (backlog #111). Exact paths, so a
 * route added later is behind the gate unless it is named here.
 */
const PUBLIC_PATHS = new Set([LOGIN_PATH, OPEN_INVITATION_PATH, ACCEPT_INVITATION_PATH]);

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * A memory upload streams to disk, never into a buffer, so it may be
 * larger than a document: an agency's TMX or `.sdltm` runs to hundreds
 * of megabytes (tm-format-spec.md §11).
 */
const MAX_TM_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Written into a memory the server creates (tm-format-spec.md §2.1). */
const TM_GENERATOR = 'cat-tool/server';

/** Written into a glossary the server creates (smart-glossary-spec.md §3.1). */
const GLOSSARY_GENERATOR = 'cat-tool/server';

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
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    createdAt: account.createdAt,
  };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const platform = openPlatformDb(config.dbPath);

  const app = Fastify({ logger: options.logger ?? true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  app.decorateRequest('account', null);

  // The built SPA, when the deployment has one (backlog #36). A fixed
  // root, so no request names a path (§2.5); the gate below only guards
  // `/api/`, and the bundle holds no data. The SPA routes by hash, so
  // `/` and its assets are all there is to serve and there is no
  // history-fallback to get wrong. `wildcard: true` (the default) means
  // an unknown path under the root is a 404, never `index.html`.
  if (config.webDir) await app.register(fastifyStatic, { root: config.webDir });

  // Bulk jobs (backlog #16a): imports run on worker threads, and are
  // stopped, threads gone, before the process lets go of anything.
  const jobs = new JobRegistry();
  // The job table is in memory, so at boot nothing is running and every
  // account's `tmp/` is what a crash left behind (uploads, staging memories).
  sweepUploadTemp(config.storageRoot);
  app.addHook('onClose', async () => {
    await jobs.shutdown();
    platform.close();
  });

  // --- the login gate ------------------------------------------------

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path)) return;
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
   * built. A project is the session's own unless `?owner=<account id>`
   * names another's, in which case it is reachable only through a grant
   * (`project_authorization`, backlog #45): **no grant is a 404, the same
   * as a project that does not exist**, and a grant whose scope does not
   * allow `action` is a 403. Every caller names the `action` it needs
   * (`read`, `edit` or `manage`, `core/auth/authorization.ts`), so a new
   * route cannot be added without deciding it. An owner may do anything to
   * their own.
   *
   * `owner` is the account the project lives under, which is what any
   * path built for it afterwards must use: a grantee's own storage root
   * holds none of it.
   */
  function openProject(
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ): {
    db: ReturnType<typeof openProjectDb>;
    project: Project;
    path: string;
    owner: Account;
  } | null {
    const me = owner(req);
    const missing = () => {
      void reply.code(404).send({ error: `no project named "${name}"` });
      return null;
    };
    let projectOwner = me;
    const asked = (req.query as { owner?: unknown } | undefined)?.owner;
    if (asked !== undefined) {
      const id =
        typeof asked === 'string' && /^[1-9]\d{0,14}$/.test(asked) ? Number(asked) : 0;
      if (id !== me.id) {
        const found = id === 0 ? null : getAccountById(platform, id);
        if (found === null || !isSlug(name)) return missing();
        const scope = scopeOf(platform, me.id, { accountId: found.id, name });
        if (scope === null) return missing();
        if (!scopeAllows(scope, action)) {
          void reply
            .code(403)
            .send({ error: 'your access to this project does not allow that' });
          return null;
        }
        projectOwner = found;
      }
    }
    let path: string;
    try {
      path = projectPath(config.storageRoot, projectOwner, name);
    } catch (err) {
      if (err instanceof InvalidNameError) {
        void reply.code(400).send({ error: err.message });
        return null;
      }
      throw err;
    }
    if (!existsSync(path)) return missing();
    const db = openProjectDb(path);
    const project = getProject(db);
    if (!project) {
      db.close();
      void reply.code(500).send({ error: `project "${name}" has no identity row` });
      return null;
    }
    return { db, project, path, owner: projectOwner };
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
    const opened = openProject(req, reply, req.params.name, 'manage');
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
        // A grant must not outlive its project: the next project of this
        // name would belong, in its grantee's eyes, to them (#45).
        revokeAllProjectAuthorizations(platform, {
          actor: sessionActor(req),
          project: { accountId: owner(req).id, name: req.params.name },
        });
      },
    );
    return reply.code(204).send();
  });

  app.get<{ Params: { name: string } }>('/api/projects/:name', async (req, reply) => {
    const opened = openProject(req, reply, req.params.name, 'read');
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
      const opened = openProject(req, reply, req.params.name, 'manage');
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
      const opened = openProject(req, reply, req.params.name, 'read');
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
      const opened = openProject(req, reply, req.params.name, 'read');
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
      const opened = openProject(req, reply, req.params.name, 'manage');
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
    const opened = openProject(req, reply, req.params.name, 'edit');
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
    const opened = openProject(req, reply, req.params.name, 'edit');
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
    const opened = openProject(req, reply, req.params.name, 'edit');
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
    const opened = openProject(req, reply, req.params.name, 'edit');
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
    const opened = openProject(req, reply, req.params.name, 'edit');
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
    // `peekTm`, not `openTm`: a list needs a name and a count, and an open
    // runs `integrity_check` (§10), 7.9 s at 500,000 units — on this thread,
    // for every memory, on every call (backlog #95).
    return { slug, ...peekTm(path) };
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
  //
  // The upload streams to a server-named file under the account's root,
  // and the import is a job on a worker thread (backlog #16a): this
  // answers 202 with the job, and the client polls `/api/jobs/:id`, which
  // can also cancel it. The memory is built in a staging file and renamed
  // into place only once the import has completed, so a memory that
  // exists is a whole one, and a failed or cancelled import leaves
  // nothing — not a prefix, not a half-attached file.
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
    // One import at a time per account, and a ceiling on the whole server:
    // each is a thread and a connection. Checked again once the upload has
    // landed (below), which is what actually decides; this saves the wait.
    const busy = (): { code: number; error: string } | null =>
      jobs.runningFor(account.id, 'import') >= 1
        ? { code: 409, error: 'an import is already running — wait for it, or cancel it' }
        : jobs.running() >= MAX_RUNNING_JOBS
          ? {
              code: 503,
              error: 'the server is busy with other imports — try again shortly',
            }
          : null;
    const early = busy();
    if (early) {
      part.file.resume();
      return reply.code(early.code).send({ error: early.error });
    }

    const upload = uploadTempPath(config.storageRoot, account);
    const staging = `${upload}.ctm`;
    /** Everything this request has put on disk but the memory itself. */
    const discard = (): void => {
      for (const f of [upload, staging, `${staging}-wal`, `${staging}-shm`]) {
        rmSync(f, { force: true });
      }
    };
    mkdirSync(dirname(upload), { recursive: true });
    try {
      await pipeline(part.file, createWriteStream(upload));
      if (part.file.truncated) {
        discard();
        return reply.code(413).send({ error: 'the memory file is too large' });
      }
      const late = busy();
      if (late) {
        discard();
        return reply.code(late.code).send({ error: late.error });
      }
      createTm(staging, { name: slug, generator: TM_GENERATOR }).close();
    } catch (err) {
      discard();
      throw err;
    }

    const handle =
      ext === '.tmx'
        ? startJob('tm.importTmx', {
            tmPath: staging,
            sourcePath: upload,
            sourceName: part.filename,
          })
        : startJob('tm.importSdltm', { tmPath: staging, sourcePath: upload });
    const filename = part.filename;
    const job = jobs.start({
      accountId: account.id,
      kind: 'import',
      tm: slug,
      handle,
      onSettled: (outcome) => {
        if ('failure' in outcome) {
          discard();
          const failure = outcome.failure;
          const known =
            failure instanceof JobError &&
            ['TmError', 'TmxError', 'SdltmError'].includes(failure.causeName);
          if (!known) app.log.error({ err: failure }, 'memory import failed');
          // A message may name the files the server keeps the upload in:
          // the client sees its own file's name, never a path (§2.5).
          return {
            state: 'failed',
            error: known
              ? failure.message.replaceAll(upload, filename).replaceAll(staging, slug)
              : 'the import failed',
          };
        }
        if (outcome.status === 'cancelled') {
          discard();
          return { state: 'cancelled' };
        }
        if (existsSync(path)) {
          // Made by someone else while this one ran.
          discard();
          return { state: 'failed', error: `a memory named "${slug}" already exists` };
        }
        renameSync(staging, path);
        rmSync(upload, { force: true });
        // The worker described the memory while it had it open: opening it
        // here would run `integrity_check` on this thread (seconds, at scale).
        const { warnings, summary } = outcome.value as {
          warnings: readonly string[];
          summary: TmSummary;
        };
        return { state: 'done', result: { slug, ...summary, warnings } };
      },
    });
    return reply.code(202).header('location', `/api/jobs/${job.id}`).send({ job });
  });

  // Stale work in a memory (smart-glossary-spec.md §6.2, backlog #122): the
  // units whose target uses an old or forbidden rendering of a glossary term.
  // A pass over every unit of the pair, so a job and not a request (§1.1): 202
  // with the job, and the client polls `/api/jobs/:id`, whose `result` is the
  // report. It reads the account's own memory and glossary, by slug, and writes
  // nothing. One at a time per account.
  const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
  app.post<{
    Params: { slug: string };
    Body: { glossary?: unknown; srcLang?: unknown; tgtLang?: unknown } | undefined;
  }>('/api/tms/:slug/stale-scan', async (req, reply) => {
    const account = owner(req);
    const { glossary, srcLang, tgtLang } = req.body ?? {};
    if (typeof glossary !== 'string') {
      return reply.code(400).send({ error: 'glossary must be a glossary name' });
    }
    if (
      typeof srcLang !== 'string' ||
      typeof tgtLang !== 'string' ||
      !LANG.test(srcLang) ||
      !LANG.test(tgtLang)
    ) {
      return reply
        .code(400)
        .send({ error: 'srcLang and tgtLang must be language codes, like en and de-DE' });
    }
    let tmFile: string;
    let glossaryFile: string;
    try {
      tmFile = tmPath(config.storageRoot, account, req.params.slug);
      glossaryFile = glossaryPath(config.storageRoot, account, glossary);
    } catch (err) {
      if (err instanceof InvalidNameError)
        return reply.code(400).send({ error: err.message });
      throw err;
    }
    if (!existsSync(tmFile)) {
      return reply.code(404).send({ error: `no memory named "${req.params.slug}"` });
    }
    if (!existsSync(glossaryFile)) {
      return reply.code(404).send({ error: `no glossary named "${glossary}"` });
    }
    if (jobs.runningFor(account.id, 'scan') >= 1) {
      return reply
        .code(409)
        .send({ error: 'a scan is already running — wait for it, or cancel it' });
    }
    if (jobs.running() >= MAX_RUNNING_JOBS) {
      return reply
        .code(503)
        .send({ error: 'the server is busy with other jobs — try again shortly' });
    }
    const handle = startJob('glossary.scanTm', {
      tmPath: tmFile,
      glossaryPath: glossaryFile,
      srcLang,
      tgtLang,
    });
    const job = jobs.start({
      accountId: account.id,
      kind: 'scan',
      tm: req.params.slug,
      handle,
      onSettled: (outcome) => {
        if ('failure' in outcome) {
          // A message may name a file on this server: the client gets a fixed one (§2.5).
          app.log.error({ err: outcome.failure }, 'stale scan failed');
          return { state: 'failed', error: 'the scan failed' };
        }
        if (outcome.status === 'cancelled') return { state: 'cancelled' };
        return { state: 'done', result: outcome.value };
      },
    });
    return reply.code(202).header('location', `/api/jobs/${job.id}`).send({ job });
  });

  // The account's own jobs, running first: how a screen that was left
  // (or a tab that was reloaded) finds an import still going.
  app.get('/api/jobs', async (req) => ({ jobs: jobs.list(owner(req).id) }));

  // A bulk job, by the id the call that started it returned. The account's
  // own only: another's is "no such job", as another's project is.
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = jobs.get(owner(req).id, req.params.id);
    return job ?? reply.code(404).send({ error: 'no such job' });
  });

  // Asks a running job to stop. 202, because it stops when it reaches a
  // safe point (a batch, a phase) or its thread is ended: the client
  // polls until the state is no longer `running`. A finished job is
  // returned as it is.
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = jobs.cancel(owner(req).id, req.params.id);
    if (!job) return reply.code(404).send({ error: 'no such job' });
    return reply.code(job.state === 'running' ? 202 : 200).send(job);
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
    const opened = openProject(req, reply, req.params.name, 'manage');
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
      const opened = openProject(req, reply, req.params.name, 'manage');
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
      const opened = openProject(req, reply, req.params.name, 'manage');
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
      const opened = openProject(req, reply, req.params.name, 'manage');
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
      const opened = openProject(req, reply, req.params.name, 'manage');
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
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        return pretranslate(opened.db, { actor: sessionActor(req) });
      } finally {
        opened.db.close();
      }
    },
  );

  // The project's pre-translate fuzzy threshold (v1-spec.md §6.1a, 2; issue
  // #139): what a run writes into a segment from. A person with `read` may
  // see it; changing it is `manage`, as pre-translate itself is.
  const fuzzySettingView = (db: Parameters<typeof getFuzzyThreshold>[0]) => ({
    threshold: getFuzzyThreshold(db),
    default: DEFAULT_FUZZY_THRESHOLD,
    min: FUZZY_FLOOR,
    max: FUZZY_MAX_SCORE,
  });

  app.get<{ Params: { name: string } }>(
    '/api/projects/:name/fuzzy-threshold',
    async (req, reply) => {
      const opened = openProject(req, reply, req.params.name, 'read');
      if (!opened) return reply;
      try {
        return fuzzySettingView(opened.db);
      } finally {
        opened.db.close();
      }
    },
  );

  // `{ threshold }`: a score from 50 to 99, `null` for off, `"default"` to
  // go back to the default.
  app.put<{ Params: { name: string }; Body: { threshold?: unknown } }>(
    '/api/projects/:name/fuzzy-threshold',
    async (req, reply) => {
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        const choice = req.body?.threshold;
        if (choice !== null && choice !== 'default' && !isFuzzyThreshold(choice)) {
          return reply.code(400).send({ error: FUZZY_THRESHOLD_MESSAGE });
        }
        setFuzzyThreshold(opened.db, choice, sessionActor(req));
        return fuzzySettingView(opened.db);
      } finally {
        opened.db.close();
      }
    },
  );

  // --- glossaries (smart-glossary-spec.md §5a.1; backlog #43a) --------

  app.get('/api/glossaries', async (req) =>
    listGlossarySlugs(config.storageRoot, owner(req)).map((slug) => ({ slug })),
  );

  // A glossary is created empty from JSON `{ name }`, the name its slug.
  // It carries no language pair: its variants do (§3.3).
  app.post<{ Body: { name?: unknown } }>('/api/glossaries', async (req, reply) => {
    const account = owner(req);
    const slug = req.body?.name;
    if (typeof slug !== 'string' || slug === '') {
      return reply.code(400).send({ error: 'a glossary name is required' });
    }
    let path: string;
    try {
      path = glossaryPath(config.storageRoot, account, slug);
    } catch (err) {
      if (err instanceof InvalidNameError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    if (existsSync(path)) {
      return reply.code(409).send({ error: `a glossary named "${slug}" already exists` });
    }
    mkdirSync(dirname(path), { recursive: true });
    createGlossary(path, { name: slug, generator: GLOSSARY_GENERATOR }).close();
    return reply.code(201).send({ slug });
  });

  /** A project's attached glossaries as the API shows them: slugs, never paths. */
  function glossaryRefsView(req: FastifyRequest, db: ReturnType<typeof openProjectDb>) {
    return listGlossaryRefs(db).map((ref) => ({
      id: ref.id,
      glossary: glossarySlugOf(config.storageRoot, owner(req), ref.path),
      priority: ref.priority,
      writeTarget: ref.isWriteTarget,
      enabled: ref.enabled,
    }));
  }

  app.get<{ Params: { name: string } }>(
    '/api/projects/:name/glossaries',
    async (req, reply) => {
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        return { refs: glossaryRefsView(req, opened.db) };
      } finally {
        opened.db.close();
      }
    },
  );

  // Attaches one of the account's glossaries after every one already
  // there, optionally as the write target (`addGlossaryRef`).
  app.post<{
    Params: { name: string };
    Body: { glossary?: unknown; writeTarget?: unknown };
  }>('/api/projects/:name/glossaries', async (req, reply) => {
    const opened = openProject(req, reply, req.params.name, 'manage');
    if (!opened) return reply;
    const { db } = opened;
    try {
      const { glossary, writeTarget } = req.body ?? {};
      if (typeof glossary !== 'string') {
        return reply.code(400).send({ error: 'glossary must be a glossary name' });
      }
      if (writeTarget !== undefined && typeof writeTarget !== 'boolean') {
        return reply.code(400).send({ error: 'writeTarget must be a boolean' });
      }
      let path: string;
      try {
        path = glossaryPath(config.storageRoot, owner(req), glossary);
      } catch (err) {
        if (err instanceof InvalidNameError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      if (!existsSync(path)) {
        return reply.code(404).send({ error: `no glossary named "${glossary}"` });
      }
      if (listGlossaryRefs(db).some((r) => r.path === path)) {
        return reply
          .code(409)
          .send({ error: `glossary "${glossary}" is already attached to this project` });
      }
      addGlossaryRef(db, {
        path,
        priority: nextGlossaryPriority(db),
        isWriteTarget: writeTarget ?? false,
        actor: sessionActor(req),
      });
      return reply.code(201).send({ refs: glossaryRefsView(req, db) });
    } finally {
      db.close();
    }
  });

  app.post<{ Params: { name: string; refId: string } }>(
    '/api/projects/:name/glossaries/:refId/write-target',
    async (req, reply) => {
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const { db } = opened;
      try {
        const id = Number(req.params.refId);
        if (!Number.isInteger(id) || !listGlossaryRefs(db).some((r) => r.id === id)) {
          return reply
            .code(404)
            .send({ error: `no attached glossary #${req.params.refId}` });
        }
        setGlossaryWriteTarget(db, id, { actor: sessionActor(req) });
        return { refs: glossaryRefsView(req, db) };
      } finally {
        db.close();
      }
    },
  );

  // --- the glossary session over one file (§5, §5a.1) ------------------
  //
  // Held in this process only, keyed by account, project and file: a
  // restart loses undecided work, deliberately (§5a.1).
  const glossarySessions = new Map<string, HeldSession>();
  const SESSION_URL = '/api/projects/:name/files/:fileId/glossary/session';

  /** The path of the glossary a commit writes into, if there is one on disk. */
  function glossaryWriteTargetPath(db: ReturnType<typeof openProjectDb>): string | null {
    const ref = listGlossaryRefs(db).find((r) => r.isWriteTarget && r.enabled);
    return ref && existsSync(ref.path) ? ref.path : null;
  }

  // Segments whose target lacks the write-target glossary's preferred
  // rendering, or uses a forbidden one (§6, §6.1; backlog #43c). Computed
  // on request from the stored targets, never stored. With no write target
  // there is nothing to compare against: an empty list and `glossary: null`.
  app.get<{ Params: { name: string; fileId: string } }>(
    '/api/projects/:name/files/:fileId/glossary/mismatches',
    async (req, reply) => {
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const { db, project } = opened;
      let target: ReturnType<typeof openGlossary> | null = null;
      try {
        const fileId = Number(req.params.fileId);
        if (!Number.isInteger(fileId) || !getFileSummary(db, fileId)) {
          return reply.code(404).send({ error: `no file #${req.params.fileId}` });
        }
        const targetPath = glossaryWriteTargetPath(db);
        if (targetPath === null) return { glossary: null, mismatches: [] };
        target = openGlossary(targetPath);
        const langs = { srcLang: project.srcLang, tgtLang: project.tgtLang };
        return {
          glossary: glossarySlugOf(config.storageRoot, owner(req), targetPath),
          mismatches: findMismatches(
            listTermEntries(target, langs),
            listSegments(db, fileId),
            langs,
          ),
        };
      } finally {
        target?.close();
        db.close();
      }
    },
  );

  /** Who is named in a decision: the label if there is one, else the formatted actor (as the session's commit does). */
  const decidedBy = (req: FastifyRequest): string => {
    const actor = sessionActor(req);
    return actor.label ?? formatActor(actor.actor);
  };

  // Records a mismatch row as a segment exception (§6; backlog #110): the
  // translator used an acceptable alternative here and says so. The row is named
  // by its segment and term and recomputed, never trusted from the client, so
  // only a real `missing_preferred` mismatch that names the alternative used can
  // be recorded. It never moves the preference.
  app.post<{
    Params: { name: string; fileId: string };
    Body: { segmentId?: unknown; termId?: unknown } | undefined;
  }>('/api/projects/:name/files/:fileId/glossary/exceptions', async (req, reply) => {
    const opened = openProject(req, reply, req.params.name, 'manage');
    if (!opened) return reply;
    const { db, project } = opened;
    const { segmentId, termId } = req.body ?? {};
    if (!Number.isInteger(segmentId) || !Number.isInteger(termId)) {
      db.close();
      return reply.code(400).send({ error: 'segmentId and termId must be integers' });
    }
    let target: ReturnType<typeof openGlossary> | null = null;
    try {
      const fileId = Number(req.params.fileId);
      if (!Number.isInteger(fileId) || !getFileSummary(db, fileId)) {
        return reply.code(404).send({ error: `no file #${req.params.fileId}` });
      }
      const targetPath = glossaryWriteTargetPath(db);
      if (targetPath === null) {
        return reply
          .code(409)
          .send({ error: 'this project has no glossary to record into' });
      }
      target = openGlossary(targetPath);
      const langs = { srcLang: project.srcLang, tgtLang: project.tgtLang };
      const row = findMismatches(
        listTermEntries(target, langs),
        listSegments(db, fileId),
        langs,
      ).find((m) => m.segmentId === segmentId && m.termId === termId);
      if (!row || row.kind !== 'missing_preferred' || row.found === null) {
        return reply.code(409).send({
          error: 'that segment does not use an acceptable alternative of this term',
        });
      }
      try {
        recordSegmentException(target, {
          termId: row.termId,
          lang: project.tgtLang,
          chosen: row.found,
          sourceProject: req.params.name,
          sourceSegment: row.ord,
          decidedBy: decidedBy(req),
        });
      } catch (err) {
        if (err instanceof TermError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      return { ok: true };
    } finally {
      target?.close();
      db.close();
    }
  });

  // The alternatives recorded often enough to propose making them preferred, and
  // the one write that accepts one (a ruling, `override`). Derived from the log on
  // each request; nothing about a proposal is stored.
  app.get<{ Params: { name: string } }>(
    '/api/projects/:name/glossary/proposals',
    async (req, reply) => {
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const { db, project } = opened;
      let target: ReturnType<typeof openGlossary> | null = null;
      try {
        const targetPath = glossaryWriteTargetPath(db);
        if (targetPath === null) return { glossary: null, proposals: [] };
        target = openGlossary(targetPath);
        const proposals = listExceptionProposals(target)
          .filter((p) => primarySubtag(p.lang) === primarySubtag(project.tgtLang))
          .map((p) => ({
            ...p,
            term:
              listVariants(target!, p.termId).find(
                (v) =>
                  primarySubtag(v.lang) === primarySubtag(project.srcLang) &&
                  !v.forbidden,
              )?.text ?? null,
          }));
        return {
          glossary: glossarySlugOf(config.storageRoot, owner(req), targetPath),
          proposals,
        };
      } finally {
        target?.close();
        db.close();
      }
    },
  );

  app.post<{
    Params: { name: string };
    Body: { termId?: unknown; lang?: unknown; chosen?: unknown } | undefined;
  }>('/api/projects/:name/glossary/proposals/accept', async (req, reply) => {
    const opened = openProject(req, reply, req.params.name, 'manage');
    if (!opened) return reply;
    const { db } = opened;
    const { termId, lang, chosen } = req.body ?? {};
    if (
      !Number.isInteger(termId) ||
      typeof lang !== 'string' ||
      typeof chosen !== 'string'
    ) {
      db.close();
      return reply.code(400).send({ error: 'termId, lang and chosen are required' });
    }
    let target: ReturnType<typeof openGlossary> | null = null;
    try {
      const targetPath = glossaryWriteTargetPath(db);
      if (targetPath === null) {
        return reply
          .code(409)
          .send({ error: 'this project has no glossary to write into' });
      }
      target = openGlossary(targetPath);
      try {
        acceptExceptionProposal(target, {
          termId: termId as number,
          lang,
          chosen,
          decidedBy: decidedBy(req),
        });
      } catch (err) {
        if (err instanceof TermError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      return { ok: true };
    } finally {
      target?.close();
      db.close();
    }
  });

  const heldFor = (req: FastifyRequest, name: string, fileId: string) =>
    glossarySessions.get(sessionKey(owner(req).id, name, Number(fileId)));

  app.post<{ Params: { name: string; fileId: string } }>(
    SESSION_URL,
    async (req, reply) => {
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const { db, project } = opened;
      let target: ReturnType<typeof openGlossary> | null = null;
      try {
        const fileId = Number(req.params.fileId);
        if (!Number.isInteger(fileId) || !getFileSummary(db, fileId)) {
          return reply.code(404).send({ error: `no file #${req.params.fileId}` });
        }
        const targetPath = glossaryWriteTargetPath(db);
        target = targetPath === null ? null : openGlossary(targetPath);
        let held: HeldSession;
        try {
          held = startGlossarySession(
            fileId,
            listSegments(db, fileId),
            { srcLang: project.srcLang, tgtLang: project.tgtLang },
            target,
          );
        } catch (err) {
          if (err instanceof UnsupportedGlossaryLanguage) {
            return reply.code(422).send({ error: err.message });
          }
          throw err;
        }
        const key = sessionKey(owner(req).id, req.params.name, fileId);
        const replaced = glossarySessions.has(key);
        glossarySessions.set(key, held);
        return reply.code(201).send({ replaced, session: sessionView(held) });
      } finally {
        target?.close();
        db.close();
      }
    },
  );

  app.get<{ Params: { name: string; fileId: string } }>(
    SESSION_URL,
    async (req, reply) => {
      const held = heldFor(req, req.params.name, req.params.fileId);
      if (!held)
        return reply.code(404).send({ error: 'no glossary session for this file' });
      return { session: sessionView(held) };
    },
  );

  // Each transition is the `GlossarySession` method of the same name; a
  // client names a flag by its key, never by position (§5a.1).
  function transition(
    action: string,
    apply: (held: HeldSession, body: Record<string, unknown>) => void,
  ): void {
    app.post<{
      Params: { name: string; fileId: string };
      Body: Record<string, unknown> | undefined;
    }>(`${SESSION_URL}/${action}`, async (req, reply) => {
      const held = heldFor(req, req.params.name, req.params.fileId);
      if (!held)
        return reply.code(404).send({ error: 'no glossary session for this file' });
      try {
        apply(held, req.body ?? {});
      } catch (err) {
        if (err instanceof GlossarySessionError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      return { session: sessionView(held) };
    });
  }

  const text = (body: Record<string, unknown>, field: string): string => {
    const value = body[field];
    if (typeof value !== 'string') {
      throw new GlossarySessionError(`${field} must be a string`);
    }
    return value;
  };

  transition('choose', (h, b) => h.session.choose(text(b, 'key'), text(b, 'rendering')));
  transition('propose', (h, b) => {
    const edit = text(b, 'edit');
    if (edit !== 'override' && edit !== 'deprecate') {
      throw new GlossarySessionError('edit must be "override" or "deprecate"');
    }
    h.session.proposeEdit(text(b, 'key'), edit, text(b, 'rendering'));
  });
  transition('skip', (h, b) => h.session.skip(text(b, 'key')));
  transition('reopen', (h, b) => h.session.reopen(text(b, 'key')));

  // The one write: every decided or proposed flag into the project's
  // write-target glossary, in one transaction. A project without one
  // refuses, and the session stays open with every decision in it.
  app.post<{ Params: { name: string; fileId: string } }>(
    `${SESSION_URL}/commit`,
    async (req, reply) => {
      const held = heldFor(req, req.params.name, req.params.fileId);
      if (!held)
        return reply.code(404).send({ error: 'no glossary session for this file' });
      const opened = openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      const { db } = opened;
      try {
        const targetPath = glossaryWriteTargetPath(db);
        if (targetPath === null) {
          return reply.code(409).send({
            error: 'this project has no glossary write target: attach one to commit into',
          });
        }
        const target = openGlossary(targetPath);
        let written: number;
        try {
          written = commitGlossarySession(target, held.session, {
            actor: sessionActor(req),
            sourceProject: req.params.name,
          });
        } catch (err) {
          if (err instanceof GlossarySessionError || err instanceof TermError) {
            return reply.code(409).send({ error: err.message });
          }
          throw err;
        } finally {
          target.close();
        }
        glossarySessions.delete(sessionKey(owner(req).id, req.params.name, held.fileId));
        return { written, session: sessionView(held) };
      } finally {
        db.close();
      }
    },
  );

  app.delete<{ Params: { name: string; fileId: string } }>(
    SESSION_URL,
    async (req, reply) => {
      const held = heldFor(req, req.params.name, req.params.fileId);
      if (!held)
        return reply.code(404).send({ error: 'no glossary session for this file' });
      held.session.discard();
      glossarySessions.delete(sessionKey(owner(req).id, req.params.name, held.fileId));
      return { session: sessionView(held) };
    },
  );

  // --- assignments (vendor-spec.md §4, §6; backlog #48) ---------------
  registerAssignmentRoutes(app, {
    storageRoot: config.storageRoot,
    platform,
    owner,
    sessionActor,
  });

  // --- an owner invites a vendor (backlog #111) -------------------------
  registerInvitationRoutes(app, {
    storageRoot: config.storageRoot,
    platform,
    owner,
    sessionActor,
  });

  return app;
}
