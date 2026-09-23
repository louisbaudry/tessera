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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  assembleFile,
  generateSessionToken,
  rulesFor,
  verifyPassword,
  type Project,
  type SegmenterRules,
} from '@cat-tool/core';
import {
  countSegments,
  createAccountSession,
  createProject,
  deleteAccountSession,
  getAccountByEmail,
  getAccountBySessionToken,
  getFile,
  getProject,
  insertFile,
  listFiles,
  listSegments,
  openPlatformDb,
  openProjectDb,
  type Account,
} from '@cat-tool/db';
import multipart from '@fastify/multipart';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import type { ServerConfig } from './config.js';
import { InvalidProjectNameError, listProjectNames, projectPath } from './storage.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook for every authenticated `/api/` request; null before it. */
    account: Account | null;
  }
}

export interface BuildAppOptions {
  readonly config: ServerConfig;
  /** Off in tests; a running server logs every request. */
  readonly logger?: boolean;
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

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

/** What a client sees of an account: never the password hash or the storage root. */
function publicAccount(account: Account) {
  return { id: account.id, email: account.email, createdAt: account.createdAt };
}

/** What a client sees of a project file: never the original bytes or the skeleton. */
function fileSummary(
  db: ReturnType<typeof openProjectDb>,
  file: { id: number; relPath: string; importedAt: string },
) {
  return {
    id: file.id,
    relPath: file.relPath,
    importedAt: file.importedAt,
    segmentCount: countSegments(db, file.id),
  };
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
        return reply.code(401).send({ error: 'invalid email or password' });
      }
      const token = generateSessionToken();
      const { expiresAt } = createAccountSession(platform, account.id, token);
      return { token, expiresAt, account: publicAccount(account) };
    },
  );

  app.post('/api/logout', async (req) => {
    const token = bearerToken(req);
    if (token !== null) deleteAccountSession(platform, token);
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
      if (err instanceof InvalidProjectNameError) {
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
        return { name, project: getProject(db), fileCount: listFiles(db).length };
      } finally {
        db.close();
      }
    });
  });

  app.post<{
    Body: { name?: string; srcLang?: string; tgtLang?: string; title?: string };
  }>('/api/projects', async (req, reply) => {
    const { name, srcLang, tgtLang, title } = req.body ?? {};
    if (!name || !srcLang || !tgtLang) {
      return reply.code(400).send({ error: 'name, srcLang and tgtLang are required' });
    }
    let path: string;
    try {
      path = projectPath(config.storageRoot, owner(req), name);
    } catch (err) {
      if (err instanceof InvalidProjectNameError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    if (existsSync(path)) {
      return reply.code(409).send({ error: `a project named "${name}" already exists` });
    }
    mkdirSync(dirname(path), { recursive: true });
    const db = openProjectDb(path);
    try {
      const project = createProject(db, { name: title ?? name, srcLang, tgtLang });
      return reply.code(201).send({ name, project, fileCount: 0 });
    } finally {
      db.close();
    }
  });

  app.get<{ Params: { name: string } }>('/api/projects/:name', async (req, reply) => {
    const opened = openOwnProject(req, reply, req.params.name);
    if (!opened) return reply;
    const { db, project } = opened;
    try {
      return {
        name: req.params.name,
        project,
        files: listFiles(db).map((f) => fileSummary(db, f)),
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
          fileId = insertFile(db, relPath, assembled).id;
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
        const file = getFile(db, fileId)!;
        return reply.code(201).send({
          file: fileSummary(db, file),
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
        const file = Number.isInteger(fileId) ? getFile(db, fileId) : null;
        if (!file) {
          return reply.code(404).send({ error: `no file #${req.params.fileId}` });
        }
        return { file: fileSummary(db, file), segments: listSegments(db, fileId) };
      } finally {
        db.close();
      }
    },
  );

  return app;
}
