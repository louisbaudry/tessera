/**
 * Signed webhooks for the vendor events (`planning/vendor-spec.md`, its #125
 * note): the owner's routes to register an endpoint, and the dispatcher that
 * drains the outbox the roster keeps. The queue lives in the roster file and
 * the sender is injected, so a restart loses nothing and the whole path is
 * provable without a network.
 */
import { existsSync } from 'node:fs';

import {
  addWebhookEndpoint,
  deleteWebhookEndpoint,
  dueWebhooks,
  enqueueWebhookPing,
  getAccountById,
  listAccounts,
  listWebhookEndpoints,
  nextWebhookDue,
  pruneWebhooks,
  settleWebhook,
  VendorError,
  type Account,
  type openPlatformDb,
} from '@cat-tool/db';
import type { AuditActor } from '@cat-tool/core';
import { validateWebhookUrl } from '@cat-tool/vendor-core/webhook';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { openOrCreateRoster, openRoster } from './roster.js';
import { vendorsPath } from './storage.js';
import {
  createWebhookSender,
  vetHost,
  type Resolver,
  type WebhookSender,
} from './webhook-send.js';

type Platform = ReturnType<typeof openPlatformDb>;

/** Deliveries tried per owner per pass: a slow endpoint cannot hold the rest for long. */
const BATCH = 20;
/** How often the dispatcher looks for work it was not told about (retries come due on their own). */
const TICK_MS = 15_000;

export interface WebhookDispatcherOptions {
  readonly storageRoot: string;
  readonly platform: Platform;
  readonly send: WebhookSender;
  readonly now?: () => Date;
  /** Milliseconds between passes; 0 means no timer (tests drive `runOnce`). */
  readonly tickMs?: number;
}

/**
 * Drains each owner's webhook outbox. Owners with work are remembered, found at
 * boot by one pass over the accounts that have a roster and added when a route
 * moves an assignment; an owner whose queue is empty drops out until it is
 * nudged again. Owners are served in parallel, each one's deliveries in order.
 */
export class WebhookDispatcher {
  private readonly owners = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private again = false;
  /** Set by `stop`: a nudge already queued must not touch a closed database. */
  private stopped = false;

  constructor(private readonly options: WebhookDispatcherOptions) {}

  /** Finds the owners that already have pending deliveries and starts the timer. */
  start(): void {
    for (const account of listAccounts(this.options.platform)) {
      if (account.role !== 'owner') continue;
      if (!existsSync(vendorsPath(this.options.storageRoot, account))) continue;
      const roster = openRoster(this.options.storageRoot, account);
      try {
        if (roster && nextWebhookDue(roster) !== null) this.owners.add(account.id);
      } finally {
        roster?.close();
      }
    }
    const every = this.options.tickMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.runOnce(), every);
      this.timer.unref();
      if (this.owners.size > 0) void this.runOnce();
    }
  }

  /** Something may be due for this owner: look soon, without waiting for the timer. */
  nudge(ownerId: number): void {
    this.owners.add(ownerId);
    if (this.options.tickMs === 0) return; // tests call runOnce themselves
    setImmediate(() => void this.runOnce());
  }

  /** Stops the timer and waits for a pass in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * One pass over the owners with work. Passes never overlap: a call while one is
   * running asks for another when it ends. Returns how many deliveries were tried.
   */
  async runOnce(): Promise<number> {
    if (this.stopped) return 0;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const pass = (async () => {
      let tried = 0;
      do {
        this.again = false;
        const results = await Promise.all([...this.owners].map((id) => this.serve(id)));
        tried += results.reduce((a, b) => a + b, 0);
      } while (this.again);
      return tried;
    })();
    this.running = pass;
    try {
      return await pass;
    } finally {
      this.running = null;
    }
  }

  /** One owner's due deliveries, tried in order; returns how many. */
  private async serve(ownerId: number): Promise<number> {
    const account = getAccountById(this.options.platform, ownerId);
    if (!account) {
      this.owners.delete(ownerId);
      return 0;
    }
    const now = (this.options.now ?? (() => new Date()))();
    const roster = openRoster(this.options.storageRoot, account);
    if (!roster) {
      this.owners.delete(ownerId);
      return 0;
    }
    try {
      pruneWebhooks(roster, now);
      const due = dueWebhooks(roster, now, BATCH);
      for (const delivery of due) {
        // The roster stays open across the request: it is one owner's file, no
        // other writer holds it for long, and the settle must land in the same
        // file the delivery came from.
        const attempt = await this.options.send(delivery, now);
        settleWebhook(
          roster,
          delivery.id,
          attempt,
          (this.options.now ?? (() => new Date()))(),
        );
      }
      if (nextWebhookDue(roster) === null) this.owners.delete(ownerId);
      return due.length;
    } finally {
      roster.close();
    }
  }
}

export interface WebhookRouteDeps {
  readonly storageRoot: string;
  readonly platform: Platform;
  readonly owner: (req: FastifyRequest) => Account;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  readonly dispatcher: WebhookDispatcher;
  readonly resolve?: Resolver;
  readonly isPublic?: (address: string) => boolean;
}

/** The sender the app uses unless a test injects one. */
export const defaultWebhookSender = (): WebhookSender => createWebhookSender();

/** The owner's own endpoints: register, list, remove, test. A vendor reaches none of it. */
export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): void {
  const { storageRoot } = deps;
  const forbidden = { error: 'only an owner has webhooks' };

  app.get('/api/webhooks', async (req, reply) => {
    const me = deps.owner(req);
    if (me.role !== 'owner') return reply.code(403).send(forbidden);
    const roster = openRoster(storageRoot, me);
    if (!roster) return { webhooks: [] };
    try {
      return { webhooks: listWebhookEndpoints(roster) };
    } finally {
      roster.close();
    }
  });

  app.post<{ Body: { url?: unknown } | undefined }>(
    '/api/webhooks',
    async (req, reply) => {
      const me = deps.owner(req);
      if (me.role !== 'owner') return reply.code(403).send(forbidden);
      const url = req.body?.url;
      if (typeof url !== 'string')
        return reply.code(400).send({ error: 'url must be text' });
      const shape = validateWebhookUrl(url.trim());
      if (!shape.ok) return reply.code(400).send({ error: shape.reason });
      // A courtesy at registration: a typo or a private name is refused now, not
      // discovered as six failed deliveries. The address is checked again on
      // every attempt, which is the check that counts.
      const vetted = await vetHost(shape.host, {
        ...(deps.resolve ? { resolve: deps.resolve } : {}),
        ...(deps.isPublic ? { isPublic: deps.isPublic } : {}),
      });
      if (!vetted.ok) {
        return reply.code(400).send({
          error:
            vetted.error === 'dns'
              ? 'that host name does not resolve'
              : 'that host resolves to an address that is not public',
        });
      }
      const roster = openOrCreateRoster(storageRoot, me);
      try {
        const made = addWebhookEndpoint(roster, { url, actor: deps.sessionActor(req) });
        // The secret is in this response and no other.
        return reply
          .code(201)
          .send({ webhook: { id: made.id, host: made.host }, secret: made.secret });
      } catch (err) {
        if (err instanceof VendorError)
          return reply.code(400).send({ error: err.message });
        throw err;
      } finally {
        roster.close();
      }
    },
  );

  const idOf = (raw: string): number | null => {
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  app.delete<{ Params: { id: string } }>('/api/webhooks/:id', async (req, reply) => {
    const me = deps.owner(req);
    if (me.role !== 'owner') return reply.code(403).send(forbidden);
    const id = idOf(req.params.id);
    const roster = id === null ? null : openRoster(storageRoot, me);
    if (!roster || id === null) return reply.code(404).send({ error: 'no such webhook' });
    try {
      const gone = deleteWebhookEndpoint(roster, { id, actor: deps.sessionActor(req) });
      return gone
        ? { removed: true }
        : reply.code(404).send({ error: 'no such webhook' });
    } finally {
      roster.close();
    }
  });

  app.post<{ Params: { id: string } }>('/api/webhooks/:id/test', async (req, reply) => {
    const me = deps.owner(req);
    if (me.role !== 'owner') return reply.code(403).send(forbidden);
    const id = idOf(req.params.id);
    const roster = id === null ? null : openRoster(storageRoot, me);
    if (!roster || id === null) return reply.code(404).send({ error: 'no such webhook' });
    try {
      if (!enqueueWebhookPing(roster, id)) {
        return reply.code(404).send({ error: 'no such webhook' });
      }
    } finally {
      roster.close();
    }
    deps.dispatcher.nudge(me.id);
    return reply.code(202).send({ queued: true });
  });
}
