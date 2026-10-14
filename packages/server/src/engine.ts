/**
 * The draft engine's consent and the gate (backlog #133;
 * `planning/translation-engine-spec.md` D3, D4, D8, D9, D19).
 *
 * Two kinds of route, both **owner-only and `manage`**: what a client has
 * consented to (`/api/clients/:clientId/engine`, in `platform.sqlite`), and
 * what a project asks for (`/api/projects/:name/engine`, in the project file).
 * A translator, a vendor or any other grantee never reaches them, and nothing a
 * `read` or `edit` route returns names an engine: the engine is invisible to
 * whoever does the work (D3).
 *
 * `engineFor` is the one question every later slice asks before sending
 * anything: it reads the two files and hands them to `resolveEngine`
 * (`core/draft/engine.ts`), which fails closed. No route here sends a byte
 * to an engine.
 */

import {
  isDraftEngine,
  isEngineChoice,
  resolveEngine,
  type AuditActor,
  type DraftEngine,
  type EngineChoice,
  type EngineDecision,
  type ProjectAction,
} from '@cat-tool/core';
import {
  ClientEngineError,
  EngineOverrideError,
  getClientEngine,
  getEngineOverride,
  getPortalClient,
  setClientEngineConsent,
  setClientEngineDefault,
  setEngineOverride,
  type Account,
  type openPlatformDb,
  type openProjectDb,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type Platform = ReturnType<typeof openPlatformDb>;
type ProjectDb = ReturnType<typeof openProjectDb>;

/**
 * The engine a project may use right now, or `off` and why. The gate: reads the
 * project's client and override, the owner's consent for that client, and lets
 * `resolveEngine` decide. A project with no client is `off` before any consent
 * is looked up.
 */
export function engineFor(
  platform: Platform,
  ownerId: number,
  project: ProjectDb,
): EngineDecision {
  const clientId = getPortalClient(project);
  return resolveEngine({
    hasClient: clientId !== null,
    client: clientId === null ? null : getClientEngine(platform, ownerId, clientId),
    projectOverride: getEngineOverride(project),
  });
}

export interface EngineRouteDeps {
  readonly platform: Platform;
  /** The session's account. */
  readonly owner: (req: FastifyRequest) => Account;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
  /** `openProject` of `app.ts`: answers 404/403 itself and returns null. */
  readonly openProject: (
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: ProjectAction,
  ) => { db: ProjectDb; owner: Account } | null;
}

/** `inherit` in a request is a cleared override. */
const INHERIT = 'inherit';

export function registerEngineRoutes(app: FastifyInstance, deps: EngineRouteDeps): void {
  const { platform } = deps;

  /** Owners only: a vendor account has no clients, and must not be able to set one up. */
  const ownerOnly = (req: FastifyRequest, reply: FastifyReply): Account | null => {
    const me = deps.owner(req);
    if (me.role !== 'owner') {
      void reply.code(403).send({ error: 'only an owner can do that' });
      return null;
    }
    return me;
  };

  const clientIdOf = (raw: string): number | null => {
    const id = Number(raw);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
  };

  const clientView = (ownerId: number, clientId: number) => ({
    clientId,
    ...getClientEngine(platform, ownerId, clientId),
  });

  app.get<{ Params: { clientId: string } }>(
    '/api/clients/:clientId/engine',
    async (req, reply) => {
      const me = ownerOnly(req, reply);
      if (!me) return reply;
      const clientId = clientIdOf(req.params.clientId);
      if (clientId === null) {
        return reply
          .code(400)
          .send({ error: 'clientId must be a positive whole number' });
      }
      return clientView(me.id, clientId);
    },
  );

  // `{ consent?: { tessera?: boolean, deepl?: boolean }, default?: 'off'|'tessera'|'deepl' }`.
  // Consents are applied before the default, so one request can consent and choose.
  app.put<{
    Params: { clientId: string };
    Body: { consent?: unknown; default?: unknown } | undefined;
  }>('/api/clients/:clientId/engine', async (req, reply) => {
    const me = ownerOnly(req, reply);
    if (!me) return reply;
    const clientId = clientIdOf(req.params.clientId);
    if (clientId === null) {
      return reply.code(400).send({ error: 'clientId must be a positive whole number' });
    }
    const body = req.body ?? {};
    const consent = body.consent;
    const consents: Array<[DraftEngine, boolean]> = [];
    if (consent !== undefined) {
      if (consent === null || typeof consent !== 'object' || Array.isArray(consent)) {
        return reply
          .code(400)
          .send({ error: 'consent must be an object of engine: boolean' });
      }
      for (const [engine, on] of Object.entries(consent)) {
        if (!isDraftEngine(engine) || typeof on !== 'boolean') {
          return reply
            .code(400)
            .send({ error: 'consent names an engine and says true or false' });
        }
        consents.push([engine, on]);
      }
    }
    if (body.default !== undefined && !isEngineChoice(body.default)) {
      return reply.code(400).send({ error: 'default must be off, tessera or deepl' });
    }
    try {
      // One transaction: a default refused for lack of consent must not leave the
      // consents beside it half-applied, nor their audit events behind.
      platform.transaction(() => {
        for (const [engine, on] of consents) {
          setClientEngineConsent(platform, {
            ownerId: me.id,
            clientId,
            engine,
            consent: on,
            actor: deps.sessionActor(req),
          });
        }
        if (body.default !== undefined) {
          setClientEngineDefault(platform, {
            ownerId: me.id,
            clientId,
            engine: body.default as EngineChoice,
            actor: deps.sessionActor(req),
          });
        }
      })();
    } catch (err) {
      if (err instanceof ClientEngineError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    return clientView(me.id, clientId);
  });

  const projectView = (me: Account, db: ProjectDb) => ({
    override: getEngineOverride(db),
    effective: engineFor(platform, me.id, db),
  });

  app.get<{ Params: { name: string } }>(
    '/api/projects/:name/engine',
    async (req, reply) => {
      if (!ownerOnly(req, reply)) return reply;
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        return projectView(opened.owner, opened.db);
      } finally {
        opened.db.close();
      }
    },
  );

  // `{ override: 'inherit' | 'off' | 'tessera' | 'deepl' }`: a request, never a grant.
  app.put<{ Params: { name: string }; Body: { override?: unknown } | undefined }>(
    '/api/projects/:name/engine',
    async (req, reply) => {
      if (!ownerOnly(req, reply)) return reply;
      const opened = deps.openProject(req, reply, req.params.name, 'manage');
      if (!opened) return reply;
      try {
        const value = req.body?.override;
        if (value !== INHERIT && !isEngineChoice(value)) {
          return reply
            .code(400)
            .send({ error: 'override must be inherit, off, tessera or deepl' });
        }
        try {
          setEngineOverride(
            opened.db,
            value === INHERIT ? null : (value as EngineChoice),
            deps.sessionActor(req),
          );
        } catch (err) {
          if (err instanceof EngineOverrideError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
        }
        return projectView(opened.owner, opened.db);
      } finally {
        opened.db.close();
      }
    },
  );
}
