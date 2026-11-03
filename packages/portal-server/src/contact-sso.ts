/**
 * A client contact signs in to the tenant's portal with Microsoft 365 or Google (issue #342,
 * `planning/sso-spec.md` D6, §2b). The routes, in the order a person meets them:
 *
 * 1. **start** (`POST /api/client/sso/start`), on the tenant's portal: with a contact's one-time
 *    sign-in link it links an identity (`contact_link`), without one it signs in (`contact_login`).
 *    The state is `<registry number>.<random>`, so the gateway can hand the callback to this app.
 * 2. **callback** (`GET /api/client/sso/callback`), on the portal's own neutral callback host: finds
 *    the attempt by its state, exchanges the code, verifies the token and sends the person back to
 *    their tenant's portal with a one-minute code. No session, no link.
 * 3. **redeem** (`POST /api/client/sso/redeem`), back on the tenant's portal: turns the code into a
 *    contact session, linking the identity first when a sign-in link came with it.
 *
 * Every refusal is one answer (`sign-in failed`, 401), told apart only in the log
 * (`auth.contact_login_failed`). The outbound calls and the token check are `@cat-tool/sso-http`'s,
 * shared with the CAT server.
 */

import {
  buildAuthorizationUrl,
  generateSessionToken,
  generateSsoToken,
  pkceChallenge,
  SSO_PROVIDERS,
  SsoTokenError,
  type AuditActor,
  type PortalSsoPurpose,
  type SsoProvider,
} from '@cat-tool/core';
import {
  claimPortalSsoCallback,
  completePortalSsoCallback,
  ContactIdentityTakenError,
  createContactSession,
  createPortalSsoAttempt,
  findContactByIdentity,
  linkContactIdentity,
  openContactSigninLink,
  recordFailedContactLogin,
  redeemPortalSsoHandoff,
  type openPortalDb,
} from '@cat-tool/db';
import { createTokenVerifier, SsoHttpError, type SsoHttp } from '@cat-tool/sso-http';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { TenantPortalConfig } from './tenants.js';

export const CONTACT_SSO_PROVIDERS_PATH = '/api/client/sso/providers';
export const CONTACT_SSO_START_PATH = '/api/client/sso/start';
export const CONTACT_SSO_CALLBACK_PATH = '/api/client/sso/callback';
export const CONTACT_SSO_REDEEM_PATH = '/api/client/sso/redeem';

/** The four paths answered without a credential: a person signing in has none yet. */
export const PUBLIC_CONTACT_SSO_PATHS: readonly string[] = [
  CONTACT_SSO_PROVIDERS_PATH,
  CONTACT_SSO_START_PATH,
  CONTACT_SSO_CALLBACK_PATH,
  CONTACT_SSO_REDEEM_PATH,
];

const REFUSED = { error: 'sign-in failed' };

/** The gate that refused a sign-in is its actor, never the contact it named. */
const LOGIN_GATE: AuditActor = { actor: { kind: 'system', name: 'login' }, label: null };

const MIN_BINDING = 16;
const MAX_FIELD = 512;
const isText = (value: unknown, min: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= MAX_FIELD;

/**
 * The registry number a state names (`<number>.<random>`), or `null`. Only routing: the attempt is
 * still found by the hash of the whole state, in the file of the app it is handed to.
 */
export function tenantNumberOfState(state: string): number | null {
  const match = /^(0|[1-9]\d{0,14})\.[A-Za-z0-9_-]{20,}$/.exec(state);
  return match ? Number(match[1]) : null;
}

export interface ContactSsoDeps {
  readonly db: ReturnType<typeof openPortalDb>;
  readonly config: TenantPortalConfig;
  readonly http: SsoHttp;
  readonly now: () => Date;
}

export function registerContactSsoRoutes(
  app: FastifyInstance,
  deps: ContactSsoDeps,
): void {
  const { db, config, http, now } = deps;
  const sso = config.sso;
  const configured: readonly SsoProvider[] = sso
    ? SSO_PROVIDERS.filter((p) => sso.providers[p] !== undefined)
    : [];
  const callbackUrl = sso ? `${sso.callbackOrigin}${CONTACT_SSO_CALLBACK_PATH}` : '';
  const verify = createTokenVerifier(http, now);

  const refuse = (reply: FastifyReply, reason: string) => {
    recordFailedContactLogin(db, LOGIN_GATE, reason);
    return reply.code(401).send(REFUSED);
  };

  app.get(CONTACT_SSO_PROVIDERS_PATH, async () => ({ providers: configured }));

  app.post<{ Body: { provider?: unknown; binding?: unknown; link?: unknown } }>(
    CONTACT_SSO_START_PATH,
    async (req, reply) => {
      const { provider, binding, link } = req.body ?? {};
      if (
        typeof provider !== 'string' ||
        !(configured as readonly string[]).includes(provider) ||
        !isText(binding, MIN_BINDING) ||
        (link !== undefined && !isText(link, 1))
      ) {
        return reply
          .code(400)
          .send({ error: 'a provider and a browser secret are required' });
      }
      // A sign-in link that cannot be used is the same 404 whatever the reason, before any provider.
      if (link !== undefined && !openContactSigninLink(db, link, now())) {
        return reply.code(404).send({ error: 'this sign-in link is not valid' });
      }
      const chosen = provider as SsoProvider;
      const purpose: PortalSsoPurpose =
        link === undefined ? 'contact_login' : 'contact_link';
      const state = `${config.tenantNumber ?? 0}.${generateSsoToken()}`;
      const nonce = generateSsoToken();
      const codeVerifier = generateSsoToken();
      createPortalSsoAttempt(db, {
        state,
        binding,
        nonce,
        codeVerifier,
        provider: chosen,
        purpose,
        now: now(),
      });
      return {
        url: buildAuthorizationUrl(chosen, {
          clientId: sso!.providers[chosen]!.clientId,
          redirectUri: callbackUrl,
          state,
          nonce,
          codeChallenge: pkceChallenge(codeVerifier),
        }),
      };
    },
  );

  /** Where the person goes back to: their tenant's portal, or the host they came from. */
  const backTo = (fragment: string): string => {
    if (!config.host) return `/client.html#sso=${fragment}`;
    const { protocol, port } = new URL(sso!.callbackOrigin);
    return `${protocol}//${config.host}${port ? `:${port}` : ''}/client.html#sso=${fragment}`;
  };

  app.get<{ Querystring: { code?: unknown; state?: unknown; error?: unknown } }>(
    CONTACT_SSO_CALLBACK_PATH,
    async (req, reply) => {
      const notFound = () => reply.code(404).send({ error: 'not found' });
      if (!sso) return notFound();
      const { code, state, error } = req.query;
      if (!isText(state, 1)) return notFound();
      const attempt = claimPortalSsoCallback(db, state, now());
      if (!attempt) return notFound();
      void reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer');
      const fail = (reason: string) => {
        recordFailedContactLogin(db, LOGIN_GATE, reason);
        return reply.redirect(backTo('refused'), 302);
      };
      const credentials = sso.providers[attempt.provider];
      if (!credentials || error !== undefined || !isText(code, 1))
        return fail('provider_error');
      let identity;
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
      completePortalSsoCallback(db, attempt.id, identity, handoff, now());
      return reply.redirect(backTo(handoff), 302);
    },
  );

  app.post<{ Body: { code?: unknown; binding?: unknown; link?: unknown } }>(
    CONTACT_SSO_REDEEM_PATH,
    async (req, reply) => {
      const { code, binding, link } = req.body ?? {};
      if (
        !isText(code, 1) ||
        !isText(binding, MIN_BINDING) ||
        (link !== undefined && !isText(link, 1))
      ) {
        return reply
          .code(400)
          .send({ error: 'a code and a browser secret are required' });
      }
      const purpose: PortalSsoPurpose =
        link === undefined ? 'contact_login' : 'contact_link';
      const identity = redeemPortalSsoHandoff(db, code, { purpose, binding, now: now() });
      if (!identity) return refuse(reply, 'handoff_refused');
      let contact;
      if (link !== undefined) {
        try {
          contact = linkContactIdentity(db, link, identity, now());
        } catch (err) {
          if (err instanceof ContactIdentityTakenError) {
            return reply.code(409).send({ error: err.message });
          }
          throw err;
        }
        if (!contact) return refuse(reply, 'link_unusable');
      } else {
        contact = findContactByIdentity(db, identity);
        if (!contact) return refuse(reply, 'unknown_identity');
      }
      const token = generateSessionToken();
      const { expiresAt } = createContactSession(
        db,
        contact,
        token,
        identity.provider,
        now(),
      );
      return { token, expiresAt };
    },
  );
}
