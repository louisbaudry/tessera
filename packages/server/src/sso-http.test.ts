import { describe, expect, it } from 'vitest';

import { createSsoHttp, SsoHttpError } from './sso-http.js';

const exchange = {
  provider: 'google' as const,
  code: 'auth-code-1',
  codeVerifier: 'verifier-1',
  redirectUri: 'https://auth.example.test/api/login/sso/callback',
  clientId: 'client-1',
  clientSecret: 'super-secret-value',
};

interface Call {
  url: string;
  init: RequestInit;
}

function stub(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  };
  return { calls, fetch: fetchStub };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('exchangeCode', () => {
  it("posts the code and the verifier to the provider's token endpoint, fixed in code", async () => {
    const s = stub(() => json({ id_token: 'the.id.token', access_token: 'ignored' }));
    const idToken = await createSsoHttp({ fetch: s.fetch }).exchangeCode(exchange);
    expect(idToken).toBe('the.id.token');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(s.calls[0]!.init.method).toBe('POST');
    const body = new URLSearchParams(String(s.calls[0]!.init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      code_verifier: 'verifier-1',
      redirect_uri: exchange.redirectUri,
      client_id: 'client-1',
      client_secret: 'super-secret-value',
    });
  });

  it("goes to Microsoft's endpoint for Microsoft, and names the scope it asked for", async () => {
    const s = stub(() => json({ id_token: 't' }));
    await createSsoHttp({ fetch: s.fetch }).exchangeCode({
      ...exchange,
      provider: 'microsoft',
    });
    expect(s.calls[0]!.url).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
    expect(new URLSearchParams(String(s.calls[0]!.init.body)).get('scope')).toBe(
      'openid',
    );
  });

  it('never follows a redirect', async () => {
    const s = stub(() => json({ id_token: 't' }));
    await createSsoHttp({ fetch: s.fetch }).exchangeCode(exchange);
    expect(s.calls[0]!.init.redirect).toBe('error');
  });

  it('refuses a reply with no id token', async () => {
    const s = stub(() => json({ access_token: 'only' }));
    await expect(
      createSsoHttp({ fetch: s.fetch }).exchangeCode(exchange),
    ).rejects.toBeInstanceOf(SsoHttpError);
  });

  it('refuses a reply that is not JSON', async () => {
    const s = stub(() => new Response('<html>nope</html>', { status: 200 }));
    await expect(
      createSsoHttp({ fetch: s.fetch }).exchangeCode(exchange),
    ).rejects.toBeInstanceOf(SsoHttpError);
  });

  it('carries no body, secret or code in the error of a refused exchange', async () => {
    const s = stub(() =>
      json(
        {
          error: 'invalid_grant',
          error_description: 'code auth-code-1 for super-secret-value',
        },
        400,
      ),
    );
    const error = await createSsoHttp({ fetch: s.fetch })
      .exchangeCode(exchange)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsoHttpError);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    for (const secret of [
      'auth-code-1',
      'super-secret-value',
      'verifier-1',
      'invalid_grant',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect((error as SsoHttpError).status).toBe(400);
  });

  it('carries nothing from a network failure either, and does not retry a spent code', async () => {
    let calls = 0;
    const failing: typeof fetch = async () => {
      calls += 1;
      throw new Error('connect ECONNREFUSED with client_secret=super-secret-value');
    };
    const error = await createSsoHttp({ fetch: failing })
      .exchangeCode(exchange)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsoHttpError);
    expect((error as Error).message).not.toContain('super-secret-value');
    expect((error as SsoHttpError).status).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('fetchJwks', () => {
  it('reads the published keys from the host fixed in code', async () => {
    const s = stub(() => json({ keys: [{ kty: 'RSA', kid: 'a', n: 'x', e: 'AQAB' }] }));
    const jwks = await createSsoHttp({ fetch: s.fetch }).fetchJwks('microsoft');
    expect(jwks.keys).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(
      'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    );
    expect(s.calls[0]!.init.redirect).toBe('error');
  });

  it("reads Google's from Google", async () => {
    const s = stub(() => json({ keys: [] }));
    await createSsoHttp({ fetch: s.fetch }).fetchJwks('google');
    expect(s.calls[0]!.url).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('refuses a reply that is not a key set', async () => {
    for (const reply of [
      () => json({ nothing: true }),
      () => json({ keys: 'no' }),
      () => json({}, 500),
    ]) {
      await expect(
        createSsoHttp({ fetch: stub(reply).fetch }).fetchJwks('google'),
      ).rejects.toBeInstanceOf(SsoHttpError);
    }
  });
});
