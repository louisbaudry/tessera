/**
 * The two outbound calls single sign-on makes (`planning/sso-spec.md` D4, D5, §2b), shared by the
 * CAT server and the portal so neither keeps a copy: redeeming a
 * provider's authorization code for an ID token, and reading its published signing keys.
 *
 * The same rules every outbound call here keeps (the draft engines, the webhook sender): the
 * hosts are fixed in code (`SSO_ENDPOINTS`) so no request or setting can point them elsewhere, a
 * redirect is never followed, and **an error carries no message, body, code or secret**: a
 * provider's refusal can quote the very values that were sent. A code is single use, so the
 * exchange is not retried.
 */

import {
  SSO_ENDPOINTS,
  SsoTokenError,
  verifyIdToken,
  type SsoIdentity,
  type SsoProvider,
} from '@cat-tool/core';
import type { JSONWebKeySet } from 'jose';

/** What the exchange needs, all of it already validated by the caller. */
export interface CodeExchange {
  readonly provider: SsoProvider;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The seam tests replace: the real one reaches the providers, a fake never leaves the process. */
export interface SsoHttp {
  /** The ID token a provider returns for an authorization code. */
  exchangeCode(exchange: CodeExchange): Promise<string>;
  /** The provider's published signing keys. */
  fetchJwks(provider: SsoProvider): Promise<JSONWebKeySet>;
}

/** A call that did not give what was asked. The message is fixed text, safe to log. */
export class SsoHttpError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or `null` when no usable reply came. */
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'SsoHttpError';
  }
}

export interface SsoHttpOptions {
  /** Test seam: a stub for the network. */
  readonly fetch?: typeof fetch;
  /** Per call. Default 10 s: a person is waiting at the provider's door. */
  readonly timeoutMs?: number;
}

/** A reply, or a fixed-text error for a network failure, whatever the failure said. */
async function call(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  let reply: Response;
  try {
    // `redirect: 'error'`: a provider that redirects an exchange is not one to follow.
    reply = await doFetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new SsoHttpError(`${what} failed: no reply`, null);
  }
  if (!reply.ok) throw new SsoHttpError(`${what} failed (${reply.status})`, reply.status);
  return reply;
}

async function jsonOf(reply: Response, what: string): Promise<unknown> {
  try {
    return await reply.json();
  } catch {
    throw new SsoHttpError(`${what} failed: not JSON`, reply.status);
  }
}

export function createSsoHttp(options: SsoHttpOptions = {}): SsoHttp {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async exchangeCode(exchange) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: exchange.code,
        code_verifier: exchange.codeVerifier,
        redirect_uri: exchange.redirectUri,
        client_id: exchange.clientId,
        client_secret: exchange.clientSecret,
      });
      // Microsoft's token request names the scope of the request it answers; Google ignores it.
      if (exchange.provider === 'microsoft') body.set('scope', 'openid');
      const reply = await call(
        doFetch,
        SSO_ENDPOINTS[exchange.provider].tokenEndpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: body.toString(),
        },
        timeoutMs,
        'token exchange',
      );
      const parsed = await jsonOf(reply, 'token exchange');
      const idToken = (parsed as { id_token?: unknown } | null)?.id_token;
      if (typeof idToken !== 'string' || idToken === '') {
        throw new SsoHttpError('token exchange failed: no id token', reply.status);
      }
      return idToken;
    },

    async fetchJwks(provider) {
      const reply = await call(
        doFetch,
        SSO_ENDPOINTS[provider].jwksUri,
        { method: 'GET', headers: { accept: 'application/json' } },
        timeoutMs,
        'key fetch',
      );
      const parsed = await jsonOf(reply, 'key fetch');
      const keys = (parsed as { keys?: unknown } | null)?.keys;
      if (!Array.isArray(keys))
        throw new SsoHttpError('key fetch failed: not a key set', reply.status);
      return parsed as JSONWebKeySet;
    },
  };
}

/** The operator's app at each provider, read from the environment; never logged or returned. */
export type SsoProviders = Readonly<
  Partial<
    Record<SsoProvider, { readonly clientId: string; readonly clientSecret: string }>
  >
>;

/**
 * The providers whose client id and secret are both set (`GOOGLE_OAUTH_CLIENT_ID` and `_SECRET`,
 * `MICROSOFT_OAUTH_CLIENT_ID` and `_SECRET`). One reading for both servers, which share the two
 * registrations (`sso-spec.md` D4, §2b).
 */
export function ssoProvidersOf(env: NodeJS.ProcessEnv): SsoProviders {
  const providers: Partial<
    Record<SsoProvider, { clientId: string; clientSecret: string }>
  > = {};
  const pairs: readonly [SsoProvider, string | undefined, string | undefined][] = [
    ['google', env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET],
    ['microsoft', env.MICROSOFT_OAUTH_CLIENT_ID, env.MICROSOFT_OAUTH_CLIENT_SECRET],
  ];
  for (const [provider, clientId, clientSecret] of pairs) {
    if (clientId && clientSecret) providers[provider] = { clientId, clientSecret };
  }
  return providers;
}

const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';

/**
 * A callback origin as typed in the environment variable `name`, checked: a bare origin, https, or
 * plain http on the local machine only.
 *
 * @returns The origin (`https://auth.example.org`).
 * @throws if it is not a URL, carries a path, query, fragment or credentials, or is plain http
 *   elsewhere than the local machine.
 */
export function callbackOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} "${raw}" is not a URL`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host === '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(host))) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(
      `${name} "${raw}" must be a bare https origin (http only on the local machine)`,
    );
  }
  return url.origin;
}

/** How long a provider's published keys are kept before they are read again. */
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Verifies a provider's ID token against its published keys, cached six hours and read again once
 * when a token names a key the cache lacks (a rotation, not yet a forgery). One per server, shared
 * by the CAT server and the portal (`sso-spec.md` D5).
 *
 * @returns `verify(provider, idToken, nonce, clientId)`, which resolves to the identity or rejects
 *   with `SsoTokenError` (from `core`) carrying the reason.
 */
export function createTokenVerifier(
  http: SsoHttp,
  now: () => Date,
): (
  provider: SsoProvider,
  idToken: string,
  nonce: string,
  clientId: string,
) => Promise<SsoIdentity> {
  const keyCache = new Map<SsoProvider, { jwks: JSONWebKeySet; at: number }>();

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

  return async (provider, idToken, nonce, clientId) => {
    const expected = { clientId, nonce, now: now() };
    const first = await keysFor(provider, false);
    try {
      return await verifyIdToken(provider, idToken, first.jwks, expected);
    } catch (err) {
      if (err instanceof SsoTokenError && err.reason === 'signature' && !first.fresh) {
        const second = await keysFor(provider, true);
        return verifyIdToken(provider, idToken, second.jwks, expected);
      }
      throw err;
    }
  };
}
