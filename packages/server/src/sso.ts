/**
 * Sign in with Microsoft 365 or Google (backlog #214, `planning/sso-spec.md`). The routes, in the
 * order a person meets them:
 *
 * 1. **start**, on a tenant's host: mints a state, a nonce and a PKCE verifier, stores the attempt
 *    and answers with the provider's URL (`POST /api/login/sso/start`, or
 *    `/api/me/identities/start` to link an identity to the account already signed in).
 * 2. **callback**, on the neutral callback host `auth.<base domain>`: the provider's one fixed
 *    redirect. Finds the attempt by its state, exchanges the code, verifies the ID token, and
 *    hands the person back to their tenant's host with a one-minute code. It makes **no session**
 *    and links nothing: it holds no authority, which is what keeps a session on its own tenant's
 *    host (D4).
 * 3. **redeem**, back on the tenant's host: turns the code into a session (login) or a link, only
 *    for the tenant, the purpose, the account and the browser that started it.
 *
 * Every way a sign-in can fail is one answer to the person (`REFUSED`) and a reason in the log
 * (`auth.sso_login_failed`): the form cannot be asked who has an account or who works for whom
 * (D9). The provider hosts are fixed in code and an error never carries what a provider said
 * (`sso-http.ts`).
 */

import {
  buildAuthorizationUrl,
  generateSessionToken,
  generateSsoToken,
  pkceChallenge,
  SSO_PROVIDERS,
  SsoTokenError,
  verifyIdToken,
  type AuditActor,
  type SsoFailure,
  type SsoIdentity,
  type SsoProvider,
  type SsoPurpose,
} from '@cat-tool/core';
import {
  accountBelongsToTenant,
  claimSsoCallback,
  completeSsoCallback,
  createSsoAttempt,
  createSsoSession,
  findAccountByIdentity,
  getTenantById,
  IdentityTakenError,
  LastWayInError,
  linkIdentity,
  listIdentities,
  NoSuchIdentityError,
  recordFailedSsoLogin,
  redeemSsoHandoff,
  unlinkIdentity,
  type Account,
  type openPlatformDb,
  type SsoAttempt,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JSONWebKeySet } from 'jose';

import type { ServerConfig } from './config.js';
import { SsoHttpError, type SsoHttp } from './sso-http.js';

type Platform = ReturnType<typeof openPlatformDb>;

/** What a sign-in is answered with whenever it fails, whatever the reason. */
const REFUSED = { error: 'sign-in failed' };

export const SSO_PROVIDERS_PATH = '/api/login/sso/providers';
export const SSO_START_PATH = '/api/login/sso/start';
export const SSO_CALLBACK_PATH = '/api/login/sso/callback';
export const SSO_REDEEM_PATH = '/api/login/sso/redeem';

/** The paths answered without a session: a person signing in has none yet. */
export const PUBLIC_SSO_PATHS: readonly string[] = [
  SSO_PROVIDERS_PATH,
  SSO_START_PATH,
  SSO_CALLBACK_PATH,
  SSO_REDEEM_PATH,
];

/** How long a provider's published keys are kept before they are read again. */
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;

const MIN_BINDING = 16;
const MAX_FIELD = 512;

export interface SsoRouteDeps {
  readonly platform: Platform;
  readonly config: ServerConfig;
  readonly http: SsoHttp;
  readonly now: () => Date;
  readonly account: (req: FastifyRequest) => Account;
  /** The account as an audit actor: its own act, as a password login is. */
  readonly auditActor: (account: Account) => AuditActor;
  /** The gate that refuses a sign-in is the actor of the refusal, never the account it named. */
  readonly loginGate: AuditActor;
  readonly publicAccount: (account: Account) => unknown;
}

/** A whole-number path parameter, or 0 (which names nothing). */
const idOf = (raw: string): number => (/^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : 0);

const isText = (value: unknown, min: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= MAX_FIELD;

export function registerSsoRoutes(app: FastifyInstance, deps: SsoRouteDeps): void {
  const { platform, config, http, now } = deps;
  const sso = config.sso;
  const configured: readonly SsoProvider[] = sso
    ? SSO_PROVIDERS.filter((p) => sso.providers[p] !== undefined)
    : [];
  const providerConfig = (provider: SsoProvider) => sso?.providers[provider];
  const callbackUrl = sso ? `${sso.callbackOrigin}${SSO_CALLBACK_PATH}` : '';

  const hostTenantId = (req: FastifyRequest): number | null => req.hostTenant?.id ?? null;

  // --- the provider's keys, cached and refreshed once on a key it has not seen -----------------

  const keyCache = new Map<SsoProvider, { jwks: JSONWebKeySet; at: number }>();

  /** The keys, and whether they were read just now (so a miss against them is final). */
  async function keysFor(
    provider: SsoProvider,
    force: boolean,
  ): Promise<{ jwks: JSONWebKeySet; fresh: boolean }> {
    const held = keyCache.get(provider);
    if (!force && held && now().getTime() - held.at < JWKS_TTL_MS) {
      return { jwks: held.jwks, fresh: false };
    }
    const jwks = await http.fetchJwks(provider);
    keyCache.set(provider, { jwks, at: now().getTime() });
    return { jwks, fresh: true };
  }

  /** The identity a token proves, or a `SsoTokenError`. A key the cache lacks is read for once. */
  async function verify(
    provider: SsoProvider,
    idToken: string,
    nonce: string,
    clientId: string,
  ): Promise<SsoIdentity> {
    const expected = { clientId, nonce, now: now() };
    const first = await keysFor(provider, false);
    try {
      return await verifyIdToken(provider, idToken, first.jwks, expected);
    } catch (err) {
      if (err instanceof SsoTokenError && err.reason === 'signature' && !first.fresh) {
        // The provider rotates its keys: a token signed with a new one is not forged, yet.
        const second = await keysFor(provider, true);
        return verifyIdToken(provider, idToken, second.jwks, expected);
      }
      throw err;
    }
  }

  // --- what the person is told, and what is logged --------------------------------------------

  const refuse = (
    reply: FastifyReply,
    reason: SsoFailure,
    provider: SsoProvider | null,
    extra: { accountId?: number; tenantId?: number | null } = {},
  ) => {
    // Told apart in the log, never in the response.
    recordFailedSsoLogin(platform, {
      actor: deps.loginGate,
      provider,
      reason,
      ...(extra.accountId !== undefined ? { accountId: extra.accountId } : {}),
      ...(extra.tenantId !== undefined ? { tenantId: extra.tenantId } : {}),
    });
    return reply.code(401).send(REFUSED);
  };

  // --- 1. start ---------------------------------------------------------------------------------

  function start(
    req: FastifyRequest<{ Body: { provider?: unknown; binding?: unknown } }>,
    reply: FastifyReply,
    purpose: SsoPurpose,
    accountId: number | null,
  ) {
    const { provider, binding } = req.body ?? {};
    if (
      typeof provider !== 'string' ||
      !(configured as readonly string[]).includes(provider) ||
      !isText(binding, MIN_BINDING)
    ) {
      return reply
        .code(400)
        .send({ error: 'a provider and a browser secret are required' });
    }
    const chosen = provider as SsoProvider;
    const credentials = providerConfig(chosen)!;
    const state = generateSsoToken();
    const nonce = generateSsoToken();
    const codeVerifier = generateSsoToken();
    createSsoAttempt(platform, {
      state,
      binding,
      nonce,
      codeVerifier,
      provider: chosen,
      purpose,
      tenantId: hostTenantId(req),
      accountId,
      now: now(),
    });
    return {
      url: buildAuthorizationUrl(chosen, {
        clientId: credentials.clientId,
        redirectUri: callbackUrl,
        state,
        nonce,
        codeChallenge: pkceChallenge(codeVerifier),
      }),
    };
  }

  app.get(SSO_PROVIDERS_PATH, async () => ({ providers: configured }));

  app.post<{ Body: { provider?: unknown; binding?: unknown } }>(
    SSO_START_PATH,
    async (req, reply) => start(req, reply, 'login', null),
  );

  // --- 2. callback (on the neutral host) --------------------------------------------------------

  /** The address the person is sent back to: their tenant's host, or the same one with no base domain. */
  function backTo(attempt: SsoAttempt, fragment: string): string | null {
    if (!config.baseDomain) return `/#sso=${fragment}`;
    const tenant =
      attempt.tenantId === null ? null : getTenantById(platform, attempt.tenantId);
    if (!tenant?.slug) return null;
    const { protocol, port } = new URL(sso!.callbackOrigin);
    return `${protocol}//${tenant.slug}.${config.baseDomain}${port ? `:${port}` : ''}/#sso=${fragment}`;
  }

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

  app.get<{ Querystring: { code?: unknown; state?: unknown; error?: unknown } }>(
    SSO_CALLBACK_PATH,
    async (req, reply) => {
      // Only the callback host answers the provider: on a tenant's host this route does not exist,
      // and nothing is claimed, so the attempt is still there for the right host.
      if (!sso || req.hostTenant) return notFound(reply);
      const { code, state, error } = req.query;
      if (!isText(state, 1)) return notFound(reply);
      const attempt = claimSsoCallback(platform, state, now());
      if (!attempt) return notFound(reply);

      void reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer');
      const credentials = providerConfig(attempt.provider);
      const finish = (fragment: string) => {
        const to = backTo(attempt, fragment);
        return to === null ? notFound(reply) : reply.redirect(to, 302);
      };
      const fail = (reason: SsoFailure) => {
        recordFailedSsoLogin(platform, {
          actor: deps.loginGate,
          provider: attempt.provider,
          reason,
          tenantId: attempt.tenantId,
        });
        return finish('refused');
      };

      if (credentials === undefined) return fail('provider_error');
      // The provider says no (the person declined, or it failed): nothing to exchange.
      if (error !== undefined || !isText(code, 1)) return fail('provider_error');

      let identity: SsoIdentity;
      try {
        const idToken = await http.exchangeCode({
          provider: attempt.provider,
          code,
          codeVerifier: attempt.codeVerifier,
          redirectUri: callbackUrl,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
        });
        identity = await verify(
          attempt.provider,
          idToken,
          attempt.nonce,
          credentials.clientId,
        );
      } catch (err) {
        if (err instanceof SsoTokenError) return fail(err.reason);
        if (err instanceof SsoHttpError) return fail('exchange_failed');
        throw err;
      }

      const handoff = generateSsoToken();
      completeSsoCallback(platform, attempt.id, identity, handoff, now());
      return finish(handoff);
    },
  );

  // --- 3. redeem, on the tenant's host ----------------------------------------------------------

  app.post<{ Body: { code?: unknown; binding?: unknown } }>(
    SSO_REDEEM_PATH,
    async (req, reply) => {
      const { code, binding } = req.body ?? {};
      if (!isText(code, 1) || !isText(binding, MIN_BINDING)) {
        return reply
          .code(400)
          .send({ error: 'a code and a browser secret are required' });
      }
      const host = req.hostTenant;
      const identity = redeemSsoHandoff(platform, code, {
        tenantId: hostTenantId(req),
        purpose: 'login',
        accountId: null,
        binding,
        now: now(),
      });
      const tenantId = host ? { tenantId: host.id } : {};
      if (!identity) return refuse(reply, 'handoff_refused', null, tenantId);

      const account = findAccountByIdentity(platform, identity);
      if (!account) return refuse(reply, 'unknown_identity', identity.provider, tenantId);
      // On a tenant's host the account must belong there too (D14): it fails as every other refusal does.
      if (host && !accountBelongsToTenant(platform, account.id, host.id)) {
        return refuse(reply, 'not_on_this_host', identity.provider, {
          ...tenantId,
          accountId: account.id,
        });
      }
      const token = generateSessionToken();
      const { expiresAt } = createSsoSession(platform, account.id, token, identity, {
        actor: deps.auditActor(account),
        now: now(),
        ...(host ? { tenantId: host.id } : {}),
      });
      return { token, expiresAt, account: deps.publicAccount(account) };
    },
  );

  // --- the signed-in account's own links --------------------------------------------------------

  const identitiesOf = (account: Account) => ({
    identities: listIdentities(platform, account.id),
  });

  app.get('/api/me/identities', async (req) => ({
    ...identitiesOf(deps.account(req)),
    providers: configured,
  }));

  app.post<{ Body: { provider?: unknown; binding?: unknown } }>(
    '/api/me/identities/start',
    async (req, reply) => start(req, reply, 'link', deps.account(req).id),
  );

  app.post<{ Body: { code?: unknown; binding?: unknown } }>(
    '/api/me/identities/redeem',
    async (req, reply) => {
      const account = deps.account(req);
      const { code, binding } = req.body ?? {};
      if (!isText(code, 1) || !isText(binding, MIN_BINDING)) {
        return reply
          .code(400)
          .send({ error: 'a code and a browser secret are required' });
      }
      const identity = redeemSsoHandoff(platform, code, {
        tenantId: hostTenantId(req),
        purpose: 'link',
        accountId: account.id,
        binding,
        now: now(),
      });
      if (!identity) {
        recordFailedSsoLogin(platform, {
          actor: deps.loginGate,
          provider: null,
          reason: 'handoff_refused',
          accountId: account.id,
          tenantId: hostTenantId(req),
        });
        return reply.code(400).send({ error: 'that sign-in could not be used' });
      }
      try {
        linkIdentity(platform, account.id, identity, {
          actor: deps.auditActor(account),
          now: now(),
        });
      } catch (err) {
        if (err instanceof IdentityTakenError) {
          return reply
            .code(409)
            .send({ error: 'that account is already linked to another Tessera account' });
        }
        throw err;
      }
      return identitiesOf(account);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/me/identities/:id', async (req, reply) => {
    const account = deps.account(req);
    try {
      unlinkIdentity(platform, account.id, idOf(req.params.id), {
        actor: deps.auditActor(account),
        now: now(),
      });
    } catch (err) {
      if (err instanceof NoSuchIdentityError) {
        return reply.code(404).send({ error: 'no such linked account' });
      }
      if (err instanceof LastWayInError) {
        return reply.code(409).send({ error: 'that is the only way into this account' });
      }
      throw err;
    }
    return identitiesOf(account);
  });
}
