/**
 * Fastify app wiring (portal-v0-spec.md).
 *
 * Two API surfaces sharing one `portal.sqlite`:
 *  - `/api/client/*` — bearer `client.access_token`, scoped to that
 *    client's own orders (§7).
 *  - `/api/admin/*`  — bearer admin session token from `POST
 *    /api/admin/login` (email + password against `admin_user`), sees
 *    everything.
 * Static files under `public/` serve the minimal v0 UI for both.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import {
  createAdminSession,
  createClient,
  createOrder,
  deleteAdminSession,
  getAdminUserByEmail,
  getAdminUserBySessionToken,
  getClientByToken,
  getDeliveredFile,
  getOrder,
  getSourceFile,
  insertDeliveredFile,
  insertSourceFile,
  listClients,
  listDeliveredFiles,
  listOrderEvents,
  listOrders,
  listOrdersForClient,
  listRates,
  listSourceFiles,
  openPortalDb,
  recordFailedAdminLogin,
  recordFileDownload,
  setRate,
  setStatus,
  setWordCountAndPrice,
  type AdminUser,
  type Client,
  type OrderEvent,
  type StoredFile,
  type TranslationOrder,
} from '@cat-tool/db';
import {
  ConsoleNotificationService,
  estimateOrder,
  generateSessionToken,
  InvalidTransitionError,
  RateNotFoundError,
  verifyPassword,
  type AuditActor,
  type NotificationService,
} from '@cat-tool/portal-core';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import type { PortalConfig } from './config.js';
import { SmtpNotificationService } from './notification/smtp.js';
import {
  attachmentDisposition,
  deliveredFilePath,
  displayFilename,
  mintStoredName,
  readStoredFilePath,
  sourceFilePath,
  writeStoredFile,
} from './storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the admin gate for every authenticated `/api/admin/` request; null otherwise. */
    admin: AdminUser | null;
  }
}

/**
 * The actors this server writes as (audit-spec.md §2.1, §2.6): built
 * here and nowhere else, then passed to the `db` write each route wraps.
 * An admin is its session's account, labelled with its email. A client
 * is its private link — `client:<id>`, whoever holds that client's
 * token — and deliberately carries no label: a name would claim a
 * person the link cannot prove.
 */
function adminActor(admin: AdminUser): AuditActor {
  return { actor: { kind: 'admin', id: admin.id }, label: admin.email };
}

function clientActor(client: Client): AuditActor {
  return { actor: { kind: 'client', id: client.id }, label: null };
}

/** The admin behind a request that passed the gate. */
function sessionAdmin(req: FastifyRequest): AdminUser {
  if (!req.admin) throw new Error('admin route reached without an admin session');
  return req.admin;
}

const adminSessionActor = (req: FastifyRequest): AuditActor =>
  adminActor(sessionAdmin(req));

/** A refused login's actor: the gate, never the admin it named (spec §2.5). */
const LOGIN_GATE: AuditActor = { actor: { kind: 'system', name: 'login' }, label: null };

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** An order's history as a client sees it: who acted, never an admin's email. */
function clientOrderEvent(event: OrderEvent) {
  const { actorLabel: _actorLabel, ...rest } = event;
  return rest;
}

export interface BuildAppOptions {
  readonly config: PortalConfig;
  readonly notifications?: NotificationService;
  /** Defaults to true; tests pass false. */
  readonly logger?: boolean;
}

function serializeOrder(order: TranslationOrder) {
  return { ...order };
}

/** A file as the API shows it: where it is on disk is nobody's business. */
function serializeFile(file: StoredFile) {
  const { storagePath: _storagePath, ...rest } = file;
  return rest;
}

interface UploadedPart {
  readonly filename: string;
  readonly contentType: string;
  readonly buffer: Buffer;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const notifications =
    options.notifications ??
    (config.smtp
      ? new SmtpNotificationService(config.smtp)
      : new ConsoleNotificationService());
  const db = openPortalDb(config.dbPath);

  const app = Fastify({ logger: options.logger ?? true });
  app.decorateRequest('admin', null);
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(staticPlugin, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  app.addHook('onClose', () => {
    db.close();
  });

  // --- auth helpers -------------------------------------------------

  function requireAdmin(req: { headers: Record<string, unknown> }): AdminUser | null {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    return getAdminUserBySessionToken(db, header.slice('Bearer '.length));
  }

  function requireClient(req: { headers: Record<string, unknown> }) {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    return getClientByToken(db, header.slice('Bearer '.length));
  }

  // --- file helpers ---------------------------------------------------

  // Writes an upload under a server-minted name and returns the row
  // that describes it; the caller inserts it with whatever it records.
  function writeUpload(
    kind: 'source' | 'delivered',
    orderId: number,
    file: UploadedPart,
  ) {
    const storedName = mintStoredName();
    const relPath =
      kind === 'source'
        ? sourceFilePath(orderId, storedName)
        : deliveredFilePath(orderId, storedName);
    writeStoredFile(config.storageRoot, relPath, file.buffer);
    return {
      orderId,
      filename: displayFilename(file.filename),
      contentType: file.contentType,
      byteSize: file.buffer.byteLength,
      storagePath: relPath,
    };
  }

  // Sends a stored file back as an attachment under its recorded name,
  // recording `file.downloaded` first (audit-spec.md decision 9). `file`
  // has already been scoped to an order the caller may see; the only
  // path used is the one this server minted at upload time. The bytes
  // are read whole so the digest logged is of exactly what is sent.
  function sendStoredFile(
    reply: FastifyReply,
    kind: 'source' | 'delivered',
    file: StoredFile,
    actor: AuditActor,
  ) {
    const fullPath = readStoredFilePath(config.storageRoot, file.storagePath);
    if (!existsSync(fullPath)) {
      app.log.error({ fileId: file.id, orderId: file.orderId }, 'stored file missing');
      return reply.code(500).send({ error: 'stored file is missing from storage' });
    }
    const bytes = readFileSync(fullPath);
    recordFileDownload(db, { actor, kind, file, sha256: sha256(bytes) });
    return (
      reply
        .header('content-type', file.contentType)
        .header('content-length', bytes.byteLength)
        // The type is whatever the uploader declared; `attachment` plus
        // nosniff means the browser saves it and never renders it inline.
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', attachmentDisposition(file.filename))
        .send(bytes)
    );
  }

  // --- client-facing API ---------------------------------------------

  app.get('/api/client/me', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });
    return client;
  });

  app.get('/api/client/orders', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });
    return listOrdersForClient(db, client.id).map(serializeOrder);
  });

  app.get('/api/client/rates', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });
    return listRates(db);
  });

  // Create an order plus its source files, multipart: fields srcLang,
  // tgtLangs (repeatable), notes; file parts are the uploads.
  app.post('/api/client/orders', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });

    let srcLang: string | undefined;
    const tgtLangs: string[] = [];
    let notes: string | undefined;
    const files: UploadedPart[] = [];

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        files.push({
          filename: part.filename,
          contentType: part.mimetype,
          buffer: await part.toBuffer(),
        });
      } else if (part.fieldname === 'srcLang') {
        srcLang = String(part.value);
      } else if (part.fieldname === 'tgtLangs') {
        tgtLangs.push(String(part.value));
      } else if (part.fieldname === 'notes') {
        notes = String(part.value);
      }
    }

    if (!srcLang || tgtLangs.length === 0) {
      return reply
        .code(400)
        .send({ error: 'srcLang and at least one tgtLangs are required' });
    }
    if (files.length === 0) {
      return reply.code(400).send({ error: 'at least one file is required' });
    }

    const order = createOrder(
      db,
      { clientId: client.id, srcLang, tgtLangs, notes },
      { actor: clientActor(client) },
    );

    for (const file of files) insertSourceFile(db, writeUpload('source', order.id, file));

    void Promise.resolve(
      notifications.notifyAdmin({
        kind: 'order_submitted',
        orderId: order.id,
        clientName: client.name,
      }),
    ).catch((err: unknown) =>
      app.log.error({ err, orderId: order.id }, 'notifyAdmin failed'),
    );

    return reply.code(201).send({
      order: serializeOrder(order),
      files: listSourceFiles(db, order.id).map(serializeFile),
    });
  });

  app.get('/api/client/orders/:id', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });
    const id = Number((req.params as { id: string }).id);
    const order = getOrder(db, id);
    if (!order || order.clientId !== client.id) {
      return reply.code(404).send({ error: 'order not found' });
    }
    return {
      order: serializeOrder(order),
      sourceFiles: listSourceFiles(db, id).map(serializeFile),
      deliveredFiles: listDeliveredFiles(db, id).map(serializeFile),
      events: listOrderEvents(db, id).map(clientOrderEvent),
    };
  });

  // The delivery itself: a client downloads a translated file of their
  // own order. Another client's order — or a file id from another order
  // — is a 404, the same answer as an order that does not exist.
  app.get('/api/client/orders/:id/delivered-files/:fileId', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });
    const { id, fileId } = req.params as { id: string; fileId: string };
    const order = getOrder(db, Number(id));
    if (!order || order.clientId !== client.id) {
      return reply.code(404).send({ error: 'order not found' });
    }
    const file = getDeliveredFile(db, order.id, Number(fileId));
    if (!file) return reply.code(404).send({ error: 'file not found' });
    return sendStoredFile(reply, 'delivered', file, clientActor(client));
  });

  // Client estimate preview before an order exists — priced from rates
  // + a client-supplied word count (or the honest "pending" if omitted).
  app.post('/api/client/estimate', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });
    const body = req.body as { srcLang: string; tgtLangs: string[]; wordCount?: number };
    if (body.wordCount === undefined) {
      return { pending: true };
    }
    try {
      const rates = listRates(db);
      const estimate = estimateOrder(rates, body.srcLang, body.tgtLangs, body.wordCount);
      return { pending: false, ...estimate };
    } catch (err) {
      if (err instanceof RateNotFoundError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/api/client/orders/:id/approve', async (req, reply) => {
    const client = requireClient(req);
    if (!client)
      return reply.code(401).send({ error: 'invalid or missing access token' });
    const id = Number((req.params as { id: string }).id);
    const order = getOrder(db, id);
    if (!order || order.clientId !== client.id) {
      return reply.code(404).send({ error: 'order not found' });
    }
    try {
      return setStatus(db, id, 'approved', {
        actor: clientActor(client),
        note: 'approved by client',
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  // --- admin API ------------------------------------------------------

  // Not behind requireAdmin — this is how you get a session token in the
  // first place.
  app.post('/api/admin/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    const admin = body.email ? getAdminUserByEmail(db, body.email) : null;
    if (!admin || !body.password || !verifyPassword(body.password, admin.passwordHash)) {
      // Told apart in the log, never in the response.
      recordFailedAdminLogin(db, {
        actor: LOGIN_GATE,
        adminUserId: admin?.id ?? null,
        reason: admin ? 'wrong_password' : 'unknown_email',
      });
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    const token = generateSessionToken();
    const { expiresAt } = createAdminSession(db, admin.id, token, {
      actor: adminActor(admin),
    });
    return { token, expiresAt };
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/admin/') || req.url === '/api/admin/login') return;
    const admin = requireAdmin(req);
    if (!admin) {
      return reply
        .code(401)
        .send({ error: 'invalid, missing, or expired admin session' });
    }
    req.admin = admin;
  });

  app.post('/api/admin/logout', async (req) => {
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      deleteAdminSession(db, header.slice('Bearer '.length));
    }
    return { ok: true };
  });

  app.get('/api/admin/orders', async () => {
    return listOrders(db).map(serializeOrder);
  });

  app.get('/api/admin/orders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: 'order not found' });
    return {
      order: serializeOrder(order),
      sourceFiles: listSourceFiles(db, id).map(serializeFile),
      deliveredFiles: listDeliveredFiles(db, id).map(serializeFile),
      events: listOrderEvents(db, id),
    };
  });

  // Intake's other half: the admin fetches what the client uploaded
  // (and can re-fetch what was delivered) without touching the volume.
  for (const [kind, lookup] of [
    ['source-files', getSourceFile],
    ['delivered-files', getDeliveredFile],
  ] as const) {
    app.get(`/api/admin/orders/:id/${kind}/:fileId`, async (req, reply) => {
      const { id, fileId } = req.params as { id: string; fileId: string };
      const order = getOrder(db, Number(id));
      if (!order) return reply.code(404).send({ error: 'order not found' });
      const file = lookup(db, order.id, Number(fileId));
      if (!file) return reply.code(404).send({ error: 'file not found' });
      const fileKind = kind === 'source-files' ? 'source' : 'delivered';
      return sendStoredFile(reply, fileKind, file, adminSessionActor(req));
    });
  }

  app.patch('/api/admin/orders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as {
      status?: string;
      note?: string;
      wordCount?: number;
    };
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: 'order not found' });

    let updated = order;

    if (body.wordCount !== undefined) {
      try {
        const rates = listRates(db);
        const estimate = estimateOrder(
          rates,
          order.srcLang,
          order.tgtLangs,
          body.wordCount,
        );
        updated = setWordCountAndPrice(db, id, body.wordCount, estimate.total);
      } catch (err) {
        if (err instanceof RateNotFoundError) {
          return reply.code(422).send({ error: err.message });
        }
        throw err;
      }
    }

    if (body.status !== undefined) {
      try {
        updated = setStatus(db, id, body.status as TranslationOrder['status'], {
          actor: adminSessionActor(req),
          note: body.note,
        });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    }

    return updated;
  });

  // Admin uploads final translated file(s); optionally marks delivered
  // in the same call (fields: markDelivered=true).
  app.post('/api/admin/orders/:id/deliver', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const order = getOrder(db, id);
    if (!order) return reply.code(404).send({ error: 'order not found' });

    let markDelivered = false;
    const files: UploadedPart[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        files.push({
          filename: part.filename,
          contentType: part.mimetype,
          buffer: await part.toBuffer(),
        });
      } else if (part.fieldname === 'markDelivered') {
        markDelivered = String(part.value) === 'true';
      }
    }

    const actor = adminSessionActor(req);
    for (const file of files) {
      insertDeliveredFile(db, writeUpload('delivered', order.id, file), {
        actor,
        sha256: sha256(file.buffer),
      });
    }

    let updated = order;
    if (markDelivered) {
      try {
        updated = setStatus(db, id, 'delivered', {
          actor,
          note: 'final files delivered',
        });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
      const client = listClients(db).find((c) => c.id === order.clientId);
      if (client) {
        void Promise.resolve(
          notifications.notifyClient({
            kind: 'order_delivered',
            orderId: order.id,
            clientEmail: client.email,
          }),
        ).catch((err: unknown) =>
          app.log.error({ err, orderId: order.id }, 'notifyClient failed'),
        );
      }
    }

    return {
      order: serializeOrder(updated),
      deliveredFiles: listDeliveredFiles(db, id).map(serializeFile),
    };
  });

  app.get('/api/admin/clients', async () => listClients(db));

  app.post('/api/admin/clients', async (req) => {
    const body = req.body as { name: string; email: string };
    return createClient(db, body.name, body.email);
  });

  app.get('/api/admin/rates', async () => listRates(db));

  app.post('/api/admin/rates', async (req) => {
    const body = req.body as {
      srcLang: string;
      tgtLang: string;
      ratePerWord: number;
      minimumPrice: number;
    };
    setRate(db, body);
    return listRates(db);
  });

  return app;
}
