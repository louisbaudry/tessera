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
  fireDeadlineNotices,
  getTenantById,
  getReminderLead,
  listTenants,
  listWebhookEndpoints,
  nextNoticeAt,
  nextWebhookDue,
  pruneWebhooks,
  setReminderLead,
  settleWebhook,
  VendorError,
  type openPlatformDb,
  type Tenant,
} from '@cat-tool/db';
import type { AuditActor } from '@cat-tool/core';
import { DEFAULT_REMINDER_LEAD_HOURS, isReminderLead } from '@cat-tool/vendor-core';
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

/** Deliveries tried per tenant per pass: a slow endpoint cannot hold the rest for long. */
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

/** What the dispatcher remembers about a tenant between passes. */
interface TenantState {
  /** True while the roster may hold deliveries that are pending. */
  deliveries: boolean;
  /**
   * When the next deadline notice falls (epoch ms), null when none is ahead, or
   * undefined when it must be recomputed (after a route moved an assignment).
   */
  notice: number | null | undefined;
}

/**
 * Drains each tenant's webhook outbox and runs the deadline clock
 * (vendor-spec.md, its #155 note). Tenants with work are remembered, found at
 * boot by one pass over the tenants that have a roster and added when a route
 * moves an assignment; a tenant with nothing pending and no deadline ahead drops
 * out until it is nudged again, and one with only a deadline ahead is left
 * closed until that moment, so a roster is not opened every tick for nothing.
 * Tenants are served in parallel, each one's deliveries in order.
 */
export class WebhookDispatcher {
  private readonly tenants = new Map<number, TenantState>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private again = false;
  /** Set by `stop`: a nudge already queued must not touch a closed database. */
  private stopped = false;

  constructor(private readonly options: WebhookDispatcherOptions) {}

  /** Finds the tenants that already have pending deliveries and starts the timer. */
  start(): void {
    for (const tenant of listTenants(this.options.platform)) {
      if (!existsSync(vendorsPath(this.options.storageRoot, tenant))) continue;
      const roster = openRoster(this.options.storageRoot, tenant);
      try {
        if (roster) {
          const state: TenantState = {
            deliveries: nextWebhookDue(roster) !== null,
            notice: nextNoticeAt(roster),
          };
          if (state.deliveries || state.notice !== null) {
            this.tenants.set(tenant.id, state);
          }
        }
      } finally {
        roster?.close();
      }
    }
    const every = this.options.tickMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.runOnce(), every);
      this.timer.unref();
      if (this.tenants.size > 0) void this.runOnce();
    }
  }

  /** Something may be due for this tenant: look soon, without waiting for the timer. */
  nudge(tenantId: number): void {
    this.tenants.set(tenantId, { deliveries: true, notice: undefined });
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
   * One pass over the tenants with work. Passes never overlap: a call while one is
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
        const now = this.now().getTime();
        const ready = [...this.tenants]
          .filter(
            ([, s]) =>
              s.deliveries ||
              s.notice === undefined ||
              (s.notice !== null && s.notice <= now),
          )
          .map(([id]) => id);
        const results = await Promise.all(ready.map((id) => this.serve(id)));
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

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /**
   * One tenant's pass: fire the deadline notices that have come due, then try the
   * deliveries that are due, in order. Returns how many deliveries were tried.
   */
  private async serve(tenantId: number): Promise<number> {
    const state = this.tenants.get(tenantId);
    const tenant = getTenantById(this.options.platform, tenantId);
    if (!state || !tenant) {
      this.tenants.delete(tenantId);
      return 0;
    }
    const now = this.now();
    const roster = openRoster(this.options.storageRoot, tenant);
    if (!roster) {
      this.tenants.delete(tenantId);
      return 0;
    }
    try {
      if (
        state.notice === undefined ||
        (state.notice !== null && state.notice <= now.getTime())
      ) {
        if (fireDeadlineNotices(roster, now).queued > 0) state.deliveries = true;
        state.notice = nextNoticeAt(roster);
      }
      if (!state.deliveries) {
        if (state.notice === null) this.tenants.delete(tenantId);
        return 0;
      }
      pruneWebhooks(roster, now);
      const due = dueWebhooks(roster, now, BATCH);
      for (const delivery of due) {
        // The roster stays open across the request: it is one tenant's file, no
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
      state.deliveries = nextWebhookDue(roster) !== null;
      if (!state.deliveries && state.notice === null) this.tenants.delete(tenantId);
      return due.length;
    } finally {
      roster.close();
    }
  }
}

export interface WebhookRouteDeps {
  readonly storageRoot: string;
  readonly platform: Platform;
  /** The session's tenant, or null for an account with none (a vendor). */
  readonly tenant: (req: FastifyRequest) => Tenant | null;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  readonly dispatcher: WebhookDispatcher;
  readonly resolve?: Resolver;
  readonly isPublic?: (address: string) => boolean;
}

/** The sender the app uses unless a test injects one. */
export const defaultWebhookSender = (): WebhookSender => createWebhookSender();

/** The tenant's own endpoints: register, list, remove, test. A vendor reaches none of it. */
export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): void {
  const { storageRoot } = deps;
  const forbidden = { error: 'only an owner has webhooks' };

  app.get('/api/webhooks', async (req, reply) => {
    const tenant = deps.tenant(req);
    if (!tenant) return reply.code(403).send(forbidden);
    const roster = openRoster(storageRoot, tenant);
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
      const tenant = deps.tenant(req);
      if (!tenant) return reply.code(403).send(forbidden);
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
      const roster = openOrCreateRoster(storageRoot, tenant);
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

  // How many hours before a deadline the reminder goes (issue #155); 0 is off.
  app.get('/api/webhooks/reminders', async (req, reply) => {
    const tenant = deps.tenant(req);
    if (!tenant) return reply.code(403).send(forbidden);
    const roster = openRoster(storageRoot, tenant);
    if (!roster) return { leadHours: DEFAULT_REMINDER_LEAD_HOURS };
    try {
      return { leadHours: getReminderLead(roster) };
    } finally {
      roster.close();
    }
  });

  app.put<{ Body: { leadHours?: unknown } | undefined }>(
    '/api/webhooks/reminders',
    async (req, reply) => {
      const tenant = deps.tenant(req);
      if (!tenant) return reply.code(403).send(forbidden);
      const hours = req.body?.leadHours;
      if (!isReminderLead(hours)) {
        return reply
          .code(400)
          .send({ error: 'leadHours is a whole number of hours from 0 to 720' });
      }
      const roster = openOrCreateRoster(storageRoot, tenant);
      try {
        const leadHours = setReminderLead(roster, {
          hours,
          actor: deps.sessionActor(req),
        });
        // The next notice moves with the lead: have the dispatcher work it out again.
        deps.dispatcher.nudge(tenant.id);
        return { leadHours };
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
    const tenant = deps.tenant(req);
    if (!tenant) return reply.code(403).send(forbidden);
    const id = idOf(req.params.id);
    const roster = id === null ? null : openRoster(storageRoot, tenant);
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
    const tenant = deps.tenant(req);
    if (!tenant) return reply.code(403).send(forbidden);
    const id = idOf(req.params.id);
    const roster = id === null ? null : openRoster(storageRoot, tenant);
    if (!roster || id === null) return reply.code(404).send({ error: 'no such webhook' });
    try {
      if (!enqueueWebhookPing(roster, id)) {
        return reply.code(404).send({ error: 'no such webhook' });
      }
    } finally {
      roster.close();
    }
    deps.dispatcher.nudge(tenant.id);
    return reply.code(202).send({ queued: true });
  });
}
