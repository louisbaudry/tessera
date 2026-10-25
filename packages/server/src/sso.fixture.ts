/**
 * Test scaffolding: a provider that never leaves the process. It holds a signing key, publishes
 * the matching key set and signs the ID tokens a test asks for, with whatever a test wants wrong,
 * and it stands in for the network (`SsoHttp`) so no sign-in test reaches Google or Microsoft.
 * Like every `*.fixture.ts` it is excluded from the build.
 */

import { type SsoProvider } from '@cat-tool/core';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';

import type { CodeExchange, SsoHttp } from './sso-http.js';
import { SsoHttpError } from './sso-http.js';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export const CLIENT_IDS: Readonly<Record<SsoProvider, string>> = {
  google: 'google-client-id',
  microsoft: 'microsoft-client-id',
};
export const CLIENT_SECRETS: Readonly<Record<SsoProvider, string>> = {
  google: 'google-client-secret',
  microsoft: 'microsoft-client-secret',
};
/** A work or school directory, and a personal-account one. */
export const DIRECTORY = '11111111-2222-4333-8444-555555555555';

export interface TokenSpec {
  readonly provider: SsoProvider;
  readonly subject: string;
  readonly nonce: string;
  readonly aud?: string;
  readonly iss?: string;
  readonly exp?: number;
  readonly tid?: string;
  readonly hd?: string;
  /** Sign with a key the provider does not publish. */
  readonly forged?: boolean;
}

export class FakeProvider {
  jwksFetches = 0;
  exchanges: CodeExchange[] = [];
  /** Authorization codes the provider has issued, each to the ID token it will redeem for. */
  private readonly codes = new Map<string, string>();
  /** Codes that fail to redeem (a spent or refused one). */
  private readonly refused = new Set<string>();
  private kid = 'fake-1';
  private signing!: SigningKey;
  private forging!: SigningKey;
  private jwks!: JSONWebKeySet;
  /** What `fetchJwks` answers; a test swaps it to model key rotation. */
  private published!: JSONWebKeySet;

  static async create(): Promise<FakeProvider> {
    const fake = new FakeProvider();
    const pair = await generateKeyPair('RS256', { extractable: true });
    fake.signing = pair.privateKey;
    fake.forging = (await generateKeyPair('RS256')).privateKey;
    fake.jwks = {
      keys: [
        { ...(await exportJWK(pair.publicKey)), kid: 'fake-1', alg: 'RS256', use: 'sig' },
      ],
    };
    fake.published = fake.jwks;
    return fake;
  }

  /** The provider rotates its signing key: tokens are signed with a new one and only it is published. */
  async rotate(): Promise<void> {
    const pair = await generateKeyPair('RS256', { extractable: true });
    this.kid = `fake-${Number(this.kid.slice(5)) + 1}`;
    this.signing = pair.privateKey;
    this.jwks = {
      keys: [
        { ...(await exportJWK(pair.publicKey)), kid: this.kid, alg: 'RS256', use: 'sig' },
      ],
    };
    this.published = this.jwks;
  }

  /** Publishes no keys at all until {@link publishKeys}: a provider whose keys a cache does not hold yet. */
  withholdKeys(): void {
    this.published = { keys: [] };
  }

  publishKeys(): void {
    this.published = this.jwks;
  }

  /** An ID token as the provider would sign it. */
  async idToken(spec: TokenSpec): Promise<string> {
    const issuer =
      spec.iss ??
      (spec.provider === 'google'
        ? 'https://accounts.google.com'
        : `https://login.microsoftonline.com/${spec.tid ?? DIRECTORY}/v2.0`);
    const claims: Record<string, unknown> = { nonce: spec.nonce };
    if (spec.provider === 'microsoft') claims.tid = spec.tid ?? DIRECTORY;
    if (spec.hd !== undefined) claims.hd = spec.hd;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuer(issuer)
      .setAudience(spec.aud ?? CLIENT_IDS[spec.provider])
      .setSubject(spec.subject)
      .setIssuedAt()
      .setExpirationTime(spec.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign(spec.forged ? this.forging : this.signing);
  }

  /** The provider issues an authorization code that redeems for this token. */
  issueCode(code: string, idToken: string): void {
    this.codes.set(code, idToken);
  }

  /** The code is refused when redeemed, as a spent or revoked one is. */
  refuseCode(code: string): void {
    this.refused.add(code);
  }

  /** The network, as far as sign-in is concerned. */
  readonly http: SsoHttp = {
    exchangeCode: async (exchange) => {
      this.exchanges.push(exchange);
      const idToken = this.codes.get(exchange.code);
      if (idToken === undefined || this.refused.has(exchange.code)) {
        throw new SsoHttpError('token exchange failed (400)', 400);
      }
      // A code is single use, as at the real provider.
      this.codes.delete(exchange.code);
      return idToken;
    },
    fetchJwks: async () => {
      this.jwksFetches += 1;
      return this.published;
    },
  };
}
