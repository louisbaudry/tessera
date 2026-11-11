/**
 * Sign-in from a chat host (backlog #381, `planning/chat-connector-spec.md` §6b): the OAuth 2.1
 * endpoints a chat host needs to connect a person to the connector without a pasted token, and
 * the routes behind the consent page and the list of connections.
 *
 * Without a session (the chat host, or a browser it sent):
 *
 * - `GET /.well-known/oauth-protected-resource` (and `…/api/mcp`): which server signs people in
 *   for the connector's endpoint (RFC 9728). The endpoint's 401 points here.
 * - `GET /.well-known/oauth-authorization-server`: where to register, ask and exchange (RFC 8414).
 * - `POST /api/oauth/register`: a client registers itself (RFC 7591). Public clients only: no
 *   secret is issued, PKCE is what binds a code to whoever asked for it.
 * - `GET /api/oauth/authorize`: checks the client and its redirect address and hands the browser
 *   to the application's consent page. It decides nothing: the session lives in the page.
 * - `POST /api/oauth/token`: a code for tokens, or a refresh token for new ones. Form-encoded,
 *   as the standard says; every refusal is `invalid_grant`.
 *
 * With a session (the application):
 *
 * - `GET /api/oauth/request`: what the consent page shows of the client asking.
 * - `POST /api/oauth/consent`: the person's answer; returns the address to send the browser to.
 * - `GET /api/connections`, `DELETE /api/connections/:id`: the person's own connections.
 *
 * **A code never goes to an address the client did not register.** A request naming an unknown
 * client or another address is answered here with an error and no redirect. A loopback address
 * matches on any port (RFC 8252), as a command-line client needs.
 *
 * **The origin is configured, never read from the request**: with a base domain it is the
 * tenant's own address, otherwise `CAT_PUBLIC_ORIGIN`. With neither, every route here is a 404
 * and the connector works with a token made by hand, as before.
 *
 * **No outbound call**: the server never fetches anything a client names.
 */

import {
  generateSessionToken,
  isCodeChallenge,
  isLoopbackRedirect,
  redirectMatches,
  type AuditActor,
} from '@cat-tool/core';
import {
  ConnectorTokenError,
  createOauthCode,
  exchangeOauthCode,
  getOauthClient,
  listConnections,
  OauthClientError,
  refreshOauthConnection,
  registerOauthClient,
  revokeConnection,
  type Account,
  type IssuedTokens,
  type OauthClient,
  type openPlatformDb,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerConfig } from './config.js';

export const OAUTH_REGISTER_PATH = '/api/oauth/register';
export const OAUTH_AUTHORIZE_PATH = '/api/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/api/oauth/token';
const OAUTH_REQUEST_PATH = '/api/oauth/request';
const OAUTH_CONSENT_PATH = '/api/oauth/consent';
const CONNECTIONS_PATH = '/api/connections';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** The `/api/` paths of the flow that are answered without a session. */
export const PUBLIC_OAUTH_PATHS = [
  OAUTH_REGISTER_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_TOKEN_PATH,
] as const;

/** The name a client gets when it registered without one. */
const UNNAMED_CLIENT = 'Unnamed client';

/** The longest `state` a client may send; it is echoed back, never stored. */
const MAX_STATE = 2000;

/**
 * The origin this request's connector is reached at, or null when sign-in is not configured:
 * the tenant's own address under a base domain, else `CAT_PUBLIC_ORIGIN`. Never the `Host`.
 */
export function connectorOrigin(
  config: ServerConfig,
  req: FastifyRequest,
): string | null {
  if (config.baseDomain) {
    const slug = req.hostTenant?.slug;
    return slug ? `https://${slug}.${config.baseDomain}` : null;
  }
  return config.publicOrigin ?? null;
}

/**
 * The `WWW-Authenticate` value of the endpoint's 401 (RFC 9728 §5.1): where a client that has
 * no token learns how to get one. Null when sign-in is not configured.
 */
export function connectorChallenge(
  config: ServerConfig,
  req: FastifyRequest,
): string | null {
  const origin = connectorOrigin(config, req);
  return origin === null
    ? null
    : `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`;
}

export interface ConnectorOauthDeps {
  readonly platform: ReturnType<typeof openPlatformDb>;
  readonly config: ServerConfig;
  /** The connector endpoint's path, which the metadata names as the resource. */
  readonly mcpPath: string;
  readonly account: (req: FastifyRequest) => Account;
  /** The tenant the session is staff of, or null (a vendor's session). */
  readonly tenant: (req: FastifyRequest) => Tenant | null;
  readonly sessionActor: (req: FastifyRequest) => AuditActor;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** `redirectUri` with the given parameters added to its query. */
function withParams(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Registers the flow's routes on `app`. */
export function registerConnectorOauthRoutes(
  app: FastifyInstance,
  deps: ConnectorOauthDeps,
): void {
  const { platform, config } = deps;

  // The token endpoint is form-encoded (RFC 6749 §4.1.3); nothing else in the app is. Small,
  // and parsed to a flat object of strings like a JSON body's.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  const notConfigured = (reply: FastifyReply): FastifyReply =>
    reply.code(404).send({ error: 'not found' });

  /** The tenant of the host the request came to: a client is registered for it alone. */
  const hostTenantId = (req: FastifyRequest): number | null => req.hostTenant?.id ?? null;

  /**
   * The client a request names, if it is registered here and `redirectUri` is one of its own.
   * Null otherwise: the caller must answer without redirecting anywhere.
   */
  const clientFor = (
    req: FastifyRequest,
    clientId: unknown,
    redirectUri: unknown,
  ): OauthClient | null => {
    const id = text(clientId);
    const uri = text(redirectUri);
    if (id === null || uri === null) return null;
    const client = getOauthClient(platform, id, hostTenantId(req));
    return client && redirectMatches(client.redirectUris, uri) ? client : null;
  };

  // --- metadata ----------------------------------------------------------

  const resourceMetadata = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const origin = connectorOrigin(config, req);
    if (origin === null) return notConfigured(reply);
    return reply.send({
      resource: `${origin}${deps.mcpPath}`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
    });
  };
  app.get(RESOURCE_METADATA_PATH, resourceMetadata);
  // The path-suffixed form a client tries first for a resource that is not at the root.
  app.get(`${RESOURCE_METADATA_PATH}${deps.mcpPath}`, resourceMetadata);

  app.get(SERVER_METADATA_PATH, async (req, reply) => {
    const origin = connectorOrigin(config, req);
    if (origin === null) return notConfigured(reply);
    return reply.send({
      issuer: origin,
      authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${origin}${OAUTH_TOKEN_PATH}`,
      registration_endpoint: `${origin}${OAUTH_REGISTER_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  // --- registration ------------------------------------------------------

  app.post<{ Body: Record<string, unknown> | undefined }>(
    OAUTH_REGISTER_PATH,
    async (req, reply) => {
      if (connectorOrigin(config, req) === null) return notConfigured(reply);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const method = body.token_endpoint_auth_method;
      if (method !== undefined && method !== 'none') {
        return reply.code(400).send({
          error: 'invalid_client_metadata',
          error_description: 'only public clients (token_endpoint_auth_method "none")',
        });
      }
      try {
        const client = registerOauthClient(platform, {
          clientId: generateSessionToken(),
          name: body.client_name === undefined ? UNNAMED_CLIENT : body.client_name,
          redirectUris: body.redirect_uris,
          tenantId: hostTenantId(req),
        });
        return await reply
          .code(201)
          .header('Cache-Control', 'no-store')
          .send({
            client_id: client.clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: client.name,
            redirect_uris: client.redirectUris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          });
      } catch (error) {
        if (!(error instanceof OauthClientError)) throw error;
        if (error.problem === 'too_many') {
          return reply
            .code(429)
            .header('Retry-After', '3600')
            .send({ error: 'temporarily_unavailable', error_description: error.detail });
        }
        return reply.code(400).send({
          error:
            error.problem === 'bad_redirect'
              ? 'invalid_redirect_uri'
              : 'invalid_client_metadata',
          error_description: error.detail,
        });
      }
    },
  );

  // --- authorization: the browser's way in --------------------------------

  app.get<{ Querystring: Record<string, unknown> }>(
    OAUTH_AUTHORIZE_PATH,
    async (req, reply) => {
      const origin = connectorOrigin(config, req);
      if (origin === null) return notConfigured(reply);
      const q = req.query;
      const client = clientFor(req, q.client_id, q.redirect_uri);
      if (!client) {
        // Never a redirect: the address is not known to be the client's.
        return reply.code(400).send({
          error: 'invalid_request',
          error_description: 'unknown client or redirect address',
        });
      }
      const redirectUri = q.redirect_uri as string;
      const state = text(q.state);
      if (state !== null && state.length > MAX_STATE) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', error_description: 'state is too long' });
      }
      const refuse = (error: string): FastifyReply =>
        reply.redirect(withParams(redirectUri, { error, state }), 302);
      if (q.response_type !== 'code') return refuse('unsupported_response_type');
      if (!isCodeChallenge(q.code_challenge) || q.code_challenge_method !== 'S256') {
        return refuse('invalid_request');
      }
      if (q.resource !== undefined && q.resource !== `${origin}${deps.mcpPath}`) {
        return refuse('invalid_target');
      }
      const page = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        code_challenge: q.code_challenge,
        ...(state !== null ? { state } : {}),
      });
      // The application routes by hash, so the request rides in the fragment: it reaches the
      // page and no server log.
      return reply.redirect(`/#/connect?${page.toString()}`, 302);
    },
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    OAUTH_REQUEST_PATH,
    async (req, reply) => {
      const client = clientFor(req, req.query.client_id, req.query.redirect_uri);
      if (!client) return reply.code(404).send({ error: 'no such request' });
      const redirectUri = req.query.redirect_uri as string;
      return {
        // A stranger's claim: the page shows it as one, beside the address, which is checked.
        clientName: client.name,
        redirectHost: new URL(redirectUri).host,
        loopback: isLoopbackRedirect(redirectUri),
        // A vendor can read the page and cannot connect.
        staff: deps.tenant(req) !== null,
      };
    },
  );

  app.post<{ Body: Record<string, unknown> | undefined }>(
    OAUTH_CONSENT_PATH,
    async (req, reply) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const client = clientFor(req, body.client_id, body.redirect_uri);
      if (!client) return reply.code(404).send({ error: 'no such request' });
      const redirectUri = body.redirect_uri as string;
      const state = text(body.state);
      if (state !== null && state.length > MAX_STATE) {
        return reply.code(400).send({ error: 'state is too long' });
      }
      if (body.allow !== true) {
        return { redirect: withParams(redirectUri, { error: 'access_denied', state }) };
      }
      if (!isCodeChallenge(body.code_challenge)) {
        return reply.code(400).send({ error: 'a code challenge is required' });
      }
      const code = generateSessionToken();
      try {
        createOauthCode(platform, {
          code,
          client,
          accountId: deps.account(req).id,
          redirectUri,
          codeChallenge: body.code_challenge,
        });
      } catch (error) {
        if (!(error instanceof ConnectorTokenError)) throw error;
        return reply.code(403).send({ error: error.message });
      }
      return { redirect: withParams(redirectUri, { code, state }) };
    },
  );

  // --- tokens --------------------------------------------------------------

  app.post<{ Body: Record<string, unknown> | undefined }>(
    OAUTH_TOKEN_PATH,
    async (req, reply) => {
      const origin = connectorOrigin(config, req);
      if (origin === null) return notConfigured(reply);
      void reply.header('Cache-Control', 'no-store');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const fail = (error: string): FastifyReply => reply.code(400).send({ error });
      if (body.resource !== undefined && body.resource !== `${origin}${deps.mcpPath}`) {
        return fail('invalid_target');
      }
      const clientId = text(body.client_id);
      const accessToken = generateSessionToken();
      const refreshToken = generateSessionToken();
      let issued: IssuedTokens | null;
      if (body.grant_type === 'authorization_code') {
        const code = text(body.code);
        if (clientId === null || code === null) return fail('invalid_request');
        issued = exchangeOauthCode(platform, {
          code,
          clientId,
          redirectUri: body.redirect_uri,
          verifier: body.code_verifier,
          accessToken,
          refreshToken,
        });
      } else if (body.grant_type === 'refresh_token') {
        const presented = text(body.refresh_token);
        if (clientId === null || presented === null) return fail('invalid_request');
        issued = refreshOauthConnection(platform, {
          refreshToken: presented,
          clientId,
          accessToken,
          newRefreshToken: refreshToken,
        });
      } else {
        return fail('unsupported_grant_type');
      }
      // One answer for every refusal: nothing says whether a code, a client or a person was it.
      if (!issued) return fail('invalid_grant');
      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: refreshToken,
      });
    },
  );

  // --- the person's own connections ----------------------------------------

  app.get(CONNECTIONS_PATH, async (req) => ({
    connections: listConnections(platform, deps.account(req).id),
  }));

  app.delete<{ Params: { id: string } }>(
    `${CONNECTIONS_PATH}/:id`,
    async (req, reply) => {
      const id = /^[1-9]\d{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
      const ended =
        id !== 0 &&
        revokeConnection(platform, {
          accountId: deps.account(req).id,
          id,
          actor: deps.sessionActor(req),
        });
      if (!ended) return reply.code(404).send({ error: 'no such connection' });
      return { ended: true };
    },
  );
}
