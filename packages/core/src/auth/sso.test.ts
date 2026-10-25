import { exportJWK, generateKeyPair, SignJWT, type JWK, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildAuthorizationUrl,
  MICROSOFT_CONSUMER_TID,
  pkceChallenge,
  SSO_PROVIDERS,
  SsoTokenError,
  verifyIdToken,
  type SsoProvider,
} from './sso.js';

const CLIENT_ID = 'client-id-1';
const NONCE = 'nonce-1';
const NOW = new Date('2026-10-25T12:00:00Z');
const TID = '11111111-2222-4333-8444-555555555555';

let signing: CryptoKey;
let jwks: JSONWebKeySet;
let otherSigning: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signing = pair.privateKey as CryptoKey;
  const jwk: JWK = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'k1',
    alg: 'RS256',
    use: 'sig',
  };
  jwks = { keys: [jwk] };
  otherSigning = (await generateKeyPair('RS256')).privateKey as CryptoKey;
});

interface TokenOptions {
  readonly iss?: string;
  readonly aud?: string;
  readonly sub?: string;
  readonly nonce?: string;
  readonly exp?: number;
  readonly key?: CryptoKey;
  readonly claims?: Record<string, unknown>;
}

/** An RS256 ID token as a provider would sign it, with whatever a test wants wrong. */
async function token(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ nonce: options.nonce ?? NONCE, ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.iss ?? 'https://accounts.google.com')
    .setAudience(options.aud ?? CLIENT_ID)
    .setSubject(options.sub ?? 'subject-1')
    .setIssuedAt(Math.floor(NOW.getTime() / 1000) - 60)
    .setExpirationTime(options.exp ?? Math.floor(NOW.getTime() / 1000) + 300)
    .sign(options.key ?? signing);
}

const expected = { clientId: CLIENT_ID, nonce: NONCE, now: NOW };

async function refusal(provider: SsoProvider, idToken: string): Promise<string> {
  try {
    await verifyIdToken(provider, idToken, jwks, expected);
  } catch (err) {
    if (err instanceof SsoTokenError) return err.reason;
    throw err;
  }
  return 'accepted';
}

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('buildAuthorizationUrl', () => {
  const input = {
    clientId: CLIENT_ID,
    redirectUri: 'https://auth.example.test/api/login/sso/callback',
    state: 'state-1',
    nonce: NONCE,
    codeChallenge: 'challenge-1',
  };

  it.each(SSO_PROVIDERS)(
    'asks %s for a code with PKCE, a state and a nonce',
    (provider) => {
      const url = new URL(buildAuthorizationUrl(provider, input));
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(input.redirectUri);
      expect(url.searchParams.get('state')).toBe('state-1');
      expect(url.searchParams.get('nonce')).toBe(NONCE);
      expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      // Only what is needed to know who signed in: no email, no profile.
      expect(url.searchParams.get('scope')).toBe('openid');
    },
  );

  it('goes to the provider host fixed in code', () => {
    expect(new URL(buildAuthorizationUrl('google', input)).origin).toBe(
      'https://accounts.google.com',
    );
    expect(new URL(buildAuthorizationUrl('microsoft', input)).origin).toBe(
      'https://login.microsoftonline.com',
    );
  });
});

describe('verifyIdToken, Google', () => {
  it('accepts a good token and names the identity by issuer and subject', async () => {
    const identity = await verifyIdToken('google', await token(), jwks, expected);
    expect(identity).toEqual({
      provider: 'google',
      issuer: 'https://accounts.google.com',
      subject: 'subject-1',
      directory: null,
      hostedDomain: null,
    });
  });

  it('accepts the bare-host issuer Google also uses, as the same issuer', async () => {
    const identity = await verifyIdToken(
      'google',
      await token({ iss: 'accounts.google.com' }),
      jwks,
      expected,
    );
    expect(identity.issuer).toBe('https://accounts.google.com');
  });

  it('reports the Workspace domain when the token carries one', async () => {
    const identity = await verifyIdToken(
      'google',
      await token({ claims: { hd: 'agency.example' } }),
      jwks,
      expected,
    );
    expect(identity.hostedDomain).toBe('agency.example');
  });

  it('refuses another issuer', async () => {
    expect(await refusal('google', await token({ iss: 'https://evil.example' }))).toBe(
      'issuer',
    );
  });

  it('refuses a token minted for another app', async () => {
    expect(await refusal('google', await token({ aud: 'someone-else' }))).toBe(
      'audience',
    );
  });

  it('refuses an expired token', async () => {
    const exp = Math.floor(NOW.getTime() / 1000) - 10;
    expect(await refusal('google', await token({ exp }))).toBe('expired');
  });

  it('refuses a nonce from another attempt', async () => {
    expect(await refusal('google', await token({ nonce: 'other' }))).toBe('nonce');
  });

  it('refuses a token with no nonce at all', async () => {
    const bare = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setSubject('subject-1')
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300)
      .sign(signing);
    expect(await refusal('google', bare)).toBe('nonce');
  });

  it('refuses a token signed with a key the provider does not publish', async () => {
    expect(await refusal('google', await token({ key: otherSigning }))).toBe('signature');
  });

  it('refuses an unsigned token', async () => {
    const header = Buffer.from('{"alg":"none"}').toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: 'subject-1',
        nonce: NONCE,
        exp: Math.floor(NOW.getTime() / 1000) + 300,
      }),
    ).toString('base64url');
    expect(await refusal('google', `${header}.${body}.`)).not.toBe('accepted');
  });

  it('refuses a symmetric algorithm, even one keyed by the public modulus', async () => {
    const hs = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setSubject('subject-1')
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300)
      .sign(new TextEncoder().encode(String((jwks.keys[0] as JWK).n)));
    expect(await refusal('google', hs)).not.toBe('accepted');
  });

  it('refuses a signature algorithm other than RS256, even from a key the provider publishes', async () => {
    const pair = await generateKeyPair('RS384', { extractable: true });
    // A published key that does not say which algorithm it is for: only the verifier's own
    // list stands between this token and acceptance.
    const bare = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k384' }] };
    const idToken = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'RS384', kid: 'k384' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setSubject('subject-1')
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300)
      .sign(pair.privateKey);
    await expect(verifyIdToken('google', idToken, bare, expected)).rejects.toBeInstanceOf(
      SsoTokenError,
    );
  });

  it('refuses something that is not a token', async () => {
    expect(await refusal('google', 'not-a-jwt')).toBe('malformed');
  });

  it('refuses a token with no subject', async () => {
    const noSub = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300)
      .sign(signing);
    expect(await refusal('google', noSub)).toBe('malformed');
  });
});

describe('verifyIdToken, Microsoft', () => {
  const issuerOf = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

  it('names the identity by the directory the person signed in to', async () => {
    const identity = await verifyIdToken(
      'microsoft',
      await token({ iss: issuerOf(TID), claims: { tid: TID } }),
      jwks,
      expected,
    );
    expect(identity).toEqual({
      provider: 'microsoft',
      issuer: issuerOf(TID),
      subject: 'subject-1',
      directory: TID,
      hostedDomain: null,
    });
  });

  it('keeps one subject in two directories apart', async () => {
    const other = '99999999-2222-4333-8444-555555555555';
    const a = await verifyIdToken(
      'microsoft',
      await token({ iss: issuerOf(TID), claims: { tid: TID } }),
      jwks,
      expected,
    );
    const b = await verifyIdToken(
      'microsoft',
      await token({ iss: issuerOf(other), claims: { tid: other } }),
      jwks,
      expected,
    );
    expect(a.issuer).not.toBe(b.issuer);
  });

  it("refuses an issuer that does not match the token's own directory", async () => {
    expect(
      await refusal(
        'microsoft',
        await token({
          iss: issuerOf(TID),
          claims: { tid: '99999999-2222-4333-8444-555555555555' },
        }),
      ),
    ).toBe('issuer');
  });

  it('refuses a directory id that is not a GUID, so no issuer is built from free text', async () => {
    expect(
      await refusal(
        'microsoft',
        await token({
          iss: 'https://login.microsoftonline.com/evil/v2.0',
          claims: { tid: 'evil' },
        }),
      ),
    ).toBe('issuer');
  });

  it('refuses a token with no directory', async () => {
    expect(await refusal('microsoft', await token({ iss: issuerOf(TID) }))).toBe(
      'issuer',
    );
  });

  it('refuses the wrong audience and the wrong nonce as for Google', async () => {
    const claims = { tid: TID };
    expect(
      await refusal(
        'microsoft',
        await token({ iss: issuerOf(TID), aud: 'other', claims }),
      ),
    ).toBe('audience');
    expect(
      await refusal(
        'microsoft',
        await token({ iss: issuerOf(TID), nonce: 'other', claims }),
      ),
    ).toBe('nonce');
  });

  it('marks a personal Microsoft account, which has no organisation behind it', async () => {
    const identity = await verifyIdToken(
      'microsoft',
      await token({
        iss: issuerOf(MICROSOFT_CONSUMER_TID),
        claims: { tid: MICROSOFT_CONSUMER_TID },
      }),
      jwks,
      expected,
    );
    expect(identity.directory).toBe(MICROSOFT_CONSUMER_TID);
  });
});
