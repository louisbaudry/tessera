/**
 * Single sign-on with Microsoft 365 and Google (`planning/sso-spec.md`, backlog #214): the
 * pure half. What a provider is (the hosts fixed in code, D5), the authorization request
 * (PKCE, a state and a nonce), and what an ID token must prove before a person is named
 * by it (`verifyIdToken`, D2, D5). No HTTP and no database: the server fetches the
 * provider's published keys and hands them in, which is what lets every refusal be proved
 * from a test that signs its own tokens with a test key.
 *
 * An identity is `(provider, issuer, subject)` and nothing else. The email a token may
 * carry is never read: Microsoft says its `email` claim is not guaranteed correct and is
 * mutable ("never use it for authorization"), and Google says to key a user on `sub`
 * (both read 2026-10-25, spec §2). That is why the authorization request asks for
 * `openid` alone.
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';

/**
 * The providers a person can sign in with. A frozen literal in the migration that stores it
 * (`account_identity.provider`); `db/check-lists.test.ts` ties the two together.
 */
export const SSO_PROVIDERS = ['google', 'microsoft'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

/**
 * What a sign-in attempt is for: signing in, linking an identity to the account already signed
 * in, or (slice 2, `planning/sso-spec.md` §2a) accepting a staff or vendor invitation, or a vendor
 * joining another tenant's roster. A frozen literal in the migration (`sso_attempt.purpose`).
 */
export const SSO_PURPOSES = [
  'login',
  'link',
  'staff_invite',
  'vendor_invite',
  'join',
] as const;
export type SsoPurpose = (typeof SSO_PURPOSES)[number];

/**
 * What a portal sign-in is for (`planning/sso-spec.md` §2b): a contact linking an identity through
 * the one-time link the admin passed on, or a linked contact signing in. A frozen literal in the
 * portal migration (`sso_attempt.purpose`).
 */
export const PORTAL_SSO_PURPOSES = ['contact_link', 'contact_login'] as const;
export type PortalSsoPurpose = (typeof PORTAL_SSO_PURPOSES)[number];

/** Where a provider is reached. Fixed in code: no request and no setting can point it elsewhere. */
export interface SsoEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** The provider's published signing keys, fetched by the server and passed to {@link verifyIdToken}. */
  readonly jwksUri: string;
}

/**
 * Read from each provider's own OpenID discovery document on 2026-10-25. Microsoft's
 * `common` endpoints serve work, school and personal accounts alike.
 */
export const SSO_ENDPOINTS: Readonly<Record<SsoProvider, SsoEndpoints>> = {
  google: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  },
  microsoft: {
    authorizationEndpoint:
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  },
};

/** The `tid` Microsoft gives every personal account (Outlook.com, Xbox, ...): no organisation stands behind it. */
export const MICROSOFT_CONSUMER_TID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Google's issuer, which it also writes without the scheme. */
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_ISSUERS = [GOOGLE_ISSUER, 'accounts.google.com'];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A random URL-safe value for a state, a nonce, a PKCE verifier or a hand-off code. */
export const generateSsoToken = (): string => randomBytes(32).toString('base64url');

/** The PKCE S256 challenge of a verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface AuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

/**
 * The URL the browser is sent to for a provider's sign-in. Authorization code with PKCE,
 * a state that finds the attempt again and a nonce the token must echo.
 *
 * `scope` is `openid` only: the subject and, for Microsoft, the directory come with it, and
 * an address is neither needed nor wanted (module note). Google documents its `hd` claim as
 * present for a Workspace account without naming a scope; unconfirmed against a real account,
 * so every lock check fails closed without it (`planning/sso-spec.md` §2a).
 */
export function buildAuthorizationUrl(
  provider: SsoProvider,
  request: AuthorizationRequest,
): string {
  const url = new URL(SSO_ENDPOINTS[provider].authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** A person as one provider knows them (spec §1): never an address. */
export interface SsoIdentity {
  readonly provider: SsoProvider;
  /** Google's issuer; Microsoft's, which carries the directory, so one person in two directories is two identities. */
  readonly issuer: string;
  readonly subject: string;
  /** Microsoft's directory (`tid`); `null` for Google. Never stored apart: the issuer carries it. */
  readonly directory: string | null;
  /**
   * Google's Workspace domain (`hd`) when the token carries one; `null` otherwise. Kept on the link
   * (`account_identity.hosted_domain`): an organisation's domain, which a tenant's lock is checked on.
   */
  readonly hostedDomain: string | null;
}

/**
 * Why a sign-in was refused, for the log (D9): never in the response, where every one of
 * these is the same refusal. A token's own reason, or one of the steps around it.
 */
export type SsoFailure =
  | SsoRefusal
  | 'provider_error'
  | 'exchange_failed'
  | 'unknown_identity'
  | 'not_on_this_host'
  | 'handoff_refused'
  | 'outside_policy';

/** Why a token was not accepted. Told apart in the log, never in the response (D9). */
export type SsoRefusal =
  'malformed' | 'signature' | 'issuer' | 'audience' | 'expired' | 'nonce';

/** A token that does not prove who signed in. */
export class SsoTokenError extends Error {
  constructor(readonly reason: SsoRefusal) {
    super(`id token refused: ${reason}`);
    this.name = 'SsoTokenError';
  }
}

export interface ExpectedToken {
  /** The app's own client id at that provider: the audience the token must be for. */
  readonly clientId: string;
  /** The nonce of the attempt this token answers. */
  readonly nonce: string;
  readonly now: Date;
}

/**
 * Reads a provider's ID token back or refuses it, never repairs it (the rule `core/draft/`
 * keeps for a model's reply): signature against the keys passed in, RS256 only, audience,
 * expiry, issuer and the attempt's nonce.
 *
 * Microsoft's issuer names the directory, so it cannot be fixed in advance: the token is
 * first verified (signature, audience, expiry), and only then is its own `tid` claim, which
 * must be a GUID, used to build the issuer it has to equal. A directory id read from an
 * unverified token would be a value an attacker chose.
 *
 * @param jwks The provider's published keys, fetched by the caller.
 * @throws SsoTokenError carrying the reason; any other error is a bug.
 */
export async function verifyIdToken(
  provider: SsoProvider,
  idToken: string,
  jwks: JSONWebKeySet,
  expected: ExpectedToken,
): Promise<SsoIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      algorithms: ['RS256'],
      audience: expected.clientId,
      currentDate: expected.now,
      ...(provider === 'google' ? { issuer: GOOGLE_ISSUERS } : {}),
    }));
  } catch (err) {
    throw new SsoTokenError(refusalOf(err));
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new SsoTokenError('malformed');
  }
  if (payload.nonce !== expected.nonce) throw new SsoTokenError('nonce');

  if (provider === 'google') {
    return {
      provider,
      issuer: GOOGLE_ISSUER,
      subject: payload.sub,
      directory: null,
      hostedDomain:
        typeof payload.hd === 'string' && payload.hd !== '' ? payload.hd : null,
    };
  }
  const tid = payload.tid;
  if (
    typeof tid !== 'string' ||
    !GUID.test(tid) ||
    payload.iss !== microsoftIssuer(tid)
  ) {
    throw new SsoTokenError('issuer');
  }
  return {
    provider,
    issuer: microsoftIssuer(tid),
    subject: payload.sub,
    directory: tid,
    hostedDomain: null,
  };
}

const microsoftIssuer = (tid: string): string =>
  `https://login.microsoftonline.com/${tid}/v2.0`;

const MICROSOFT_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i;

/**
 * The Microsoft directory (`tid`) an issuer names, or `null` for an issuer that is not a
 * Microsoft directory's (Google's). The directory is part of the issuer, so it is read back from
 * it rather than stored twice (`planning/sso-spec.md` §2a).
 */
export function directoryOfIssuer(issuer: string): string | null {
  const tid = MICROSOFT_ISSUER.exec(issuer)?.[1];
  return tid !== undefined && GUID.test(tid) && issuer === microsoftIssuer(tid)
    ? tid
    : null;
}

/** A tenant's provider locks (`planning/sso-spec.md` D7): `null` leaves that provider open. */
export interface SsoLock {
  readonly microsoftTid: string | null;
  readonly googleHd: string | null;
}

/**
 * Whether an identity passes a tenant's locks. A lock is per provider: a locked provider accepts
 * only its directory or Workspace domain, an unlocked one any account of that provider. Fails
 * closed: a Google identity with no domain never meets a Google lock (§2a). Directory ids are
 * compared case-insensitively (a GUID), domains case-insensitively (a host name).
 *
 * @param identity - The provider, the issuer (Microsoft's names the directory) and Google's domain.
 * @param lock - The tenant's locks.
 */
export function identityMeetsLock(
  identity: {
    readonly provider: SsoProvider;
    readonly issuer: string;
    readonly hostedDomain: string | null;
  },
  lock: SsoLock,
): boolean {
  if (identity.provider === 'microsoft') {
    if (lock.microsoftTid === null) return true;
    const tid = directoryOfIssuer(identity.issuer);
    return tid !== null && tid.toLowerCase() === lock.microsoftTid.toLowerCase();
  }
  if (lock.googleHd === null) return true;
  return (
    identity.hostedDomain !== null &&
    identity.hostedDomain.toLowerCase() === lock.googleHd.toLowerCase()
  );
}

function refusalOf(err: unknown): SsoRefusal {
  if (err instanceof errors.JWTExpired) return 'expired';
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') return 'audience';
    if (err.claim === 'iss') return 'issuer';
    return 'malformed';
  }
  if (
    err instanceof errors.JWSSignatureVerificationFailed ||
    err instanceof errors.JWKSNoMatchingKey ||
    err instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return 'signature';
  }
  return 'malformed';
}
