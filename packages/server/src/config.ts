/**
 * Environment-driven config (v1-spec.md §2.5). Conservative defaults so
 * `pnpm --filter @cat-tool/server start` works out of the box locally;
 * a deployment (backlog #36) overrides every one of these.
 */
import { resolve } from 'node:path';

import { normaliseHost, type SsoProvider } from '@cat-tool/core';

/**
 * Single sign-on (`planning/sso-spec.md` D4): the one address provider callbacks come back to and
 * the providers the operator has registered an app with. A provider with no client id and secret
 * is off, and with none on there is no `sso` at all.
 */
export interface SsoConfig {
  /**
   * The origin of the callback host, `https://auth.<baseDomain>` by default (`auth` is a reserved
   * slug, so no tenant has it). The provider apps are registered with this origin plus the
   * callback path, exactly: the providers accept no wildcard.
   */
  readonly callbackOrigin: string;
  /** Read from the environment only; never logged, returned or put in an error. */
  readonly providers: Readonly<
    Partial<
      Record<SsoProvider, { readonly clientId: string; readonly clientSecret: string }>
    >
  >;
}

export interface ServerConfig {
  readonly port: number;
  /** `platform.sqlite` — accounts and sessions, never translation data (§4.1a). */
  readonly dbPath: string;
  /** The volume every account's storage root lives under. */
  readonly storageRoot: string;
  /**
   * The built SPA (`packages/web/dist`), served at `/` when set. Unset in
   * development, where Vite serves the SPA and proxies `/api` here; set by
   * the container image (backlog #36), which has one process to reach.
   */
  readonly webDir?: string;
  /**
   * The domain tenants' subdomains live under (`planning/tenant-spec.md` D14): a tenant is reached
   * at `<slug>.<baseDomain>` and at nothing else, and every other host (the apex included) is a
   * 404. Unset (development, or a deployment with no domain yet) there is no host check and the
   * server behaves as it always has; `localhost` works without DNS (`acme.localhost`).
   */
  readonly baseDomain?: string;
  /** Sign-in with Microsoft 365 and Google; absent when no provider is configured. */
  readonly sso?: SsoConfig;
  /**
   * The Anthropic API key the Tessera draft engine calls with (backlog #136,
   * `translation-engine-spec.md` §5). Read from the environment only, never a
   * file in the repo, and never logged or returned: unset, the engine is
   * unavailable and a draft run is refused with a plain message.
   */
  readonly anthropicApiKey?: string;
  /**
   * The DeepL API key the `deepl` draft engine calls with (backlog #256, D40).
   * The same rules as the Anthropic key: environment only, never logged or
   * returned, and unset means that engine is unavailable.
   */
  readonly deeplApiKey?: string;
  /**
   * The model id the engine asks for. A placeholder (D13): the benchmark picks
   * the tier, and the id is recorded in every draft's provenance either way.
   */
  readonly draftModel?: string;
}

/** The mid tier, until the D7 benchmark says otherwise (D13). */
export const DEFAULT_DRAFT_MODEL = 'claude-sonnet-5-5';

/** A host a person can reach without TLS: the machine they are sitting at. */
const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';

/**
 * The callback origin: `SSO_CALLBACK_ORIGIN`, or `https://auth.<baseDomain>`. With a base domain
 * the callback host is that one name and no other, because the server recognises it by name
 * (an override is for a deployment with no base domain, and for development).
 *
 * @throws if the value is not a bare origin, is plain http outside the local machine, or names
 *   another host than `auth.<baseDomain>` when there is a base domain.
 */
function callbackOriginOf(
  raw: string | undefined,
  baseDomain: string | undefined,
): string | null {
  if (!raw) return baseDomain ? `https://auth.${baseDomain}` : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SSO_CALLBACK_ORIGIN "${raw}" is not a URL`);
  }
  const host = normaliseHost(url.host);
  if (
    host === null ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(host))) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(
      `SSO_CALLBACK_ORIGIN "${raw}" must be a bare https origin (http only on the local machine)`,
    );
  }
  if (baseDomain && host !== `auth.${baseDomain}`) {
    throw new Error(
      `SSO_CALLBACK_ORIGIN must be https://auth.${baseDomain} when CAT_BASE_DOMAIN is set`,
    );
  }
  return url.origin;
}

/** The providers whose client id and secret are both set, as `{ clientId, clientSecret }`. */
function ssoOf(
  env: NodeJS.ProcessEnv,
  baseDomain: string | undefined,
): SsoConfig | undefined {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  const pairs: readonly [SsoProvider, string | undefined, string | undefined][] = [
    ['google', env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET],
    ['microsoft', env.MICROSOFT_OAUTH_CLIENT_ID, env.MICROSOFT_OAUTH_CLIENT_SECRET],
  ];
  for (const [provider, clientId, clientSecret] of pairs) {
    if (clientId && clientSecret) providers[provider] = { clientId, clientSecret };
  }
  // Read even with no provider, so a malformed value fails at startup and not later.
  const callbackOrigin = callbackOriginOf(env.SSO_CALLBACK_ORIGIN, baseDomain);
  if (callbackOrigin === null || Object.keys(providers).length === 0) return undefined;
  return { callbackOrigin, providers };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // As CAT_WEB_DIR: an empty value is unset. A value that is not a plain host name is refused
  // at startup rather than turned into a server that answers nothing.
  const baseDomain = env.CAT_BASE_DOMAIN ? normaliseHost(env.CAT_BASE_DOMAIN) : undefined;
  if (env.CAT_BASE_DOMAIN && (baseDomain === null || env.CAT_BASE_DOMAIN.includes(':'))) {
    throw new Error(
      `CAT_BASE_DOMAIN "${env.CAT_BASE_DOMAIN}" is not a plain domain name (no port, no scheme)`,
    );
  }
  const sso = ssoOf(env, baseDomain ?? undefined);
  return {
    port: Number(env.CAT_PORT ?? 3400),
    dbPath: resolve(env.CAT_DB_PATH ?? './data/platform.sqlite'),
    storageRoot: resolve(env.CAT_STORAGE_ROOT ?? './data/storage'),
    // An empty value is "unset", as `docker run -e CAT_WEB_DIR=` would mean.
    ...(env.CAT_WEB_DIR ? { webDir: resolve(env.CAT_WEB_DIR) } : {}),
    ...(baseDomain ? { baseDomain } : {}),
    ...(sso ? { sso } : {}),
    // As CAT_WEB_DIR: an empty value is unset. There is deliberately no
    // base-URL setting: the one outbound host is fixed in code, so no
    // environment value can point a client's text somewhere else.
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.DEEPL_API_KEY ? { deeplApiKey: env.DEEPL_API_KEY } : {}),
    draftModel: env.CAT_DRAFT_MODEL || DEFAULT_DRAFT_MODEL,
  };
}
