/**
 * A client contact signs in to its tenant's portal with Microsoft or Google (issue #342,
 * `planning/sso-spec.md` §2b), through a provider that never leaves the process: the one-time link,
 * the portal's own callback host handing each callback to the tenant its state names, the contact
 * session, and every refusal being one answer.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createContact,
  issueContactSigninLink,
  openPortalDb,
  setClientLinkEnabled,
  setContactDisabled,
  type Client,
} from '@cat-tool/db';
import { CLIENT_IDS, CLIENT_SECRETS, FakeProvider } from '@cat-tool/sso-http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PortalConfig } from './config.js';
import { buildGateway, type PortalGateway } from './gateway.js';
import type { PortalTenant } from './tenants.js';

const HOST_A = 'a.portal.test';
const HOST_B = 'b.portal.test';
const AUTH = 'portal-auth.portal.test';
const BINDING = 'a-browser-secret-0123456789';
const REFUSED = { error: 'sign-in failed' };

let dir: string;
let gateway: PortalGateway;
let fake: FakeProvider;
let tenants: PortalTenant[];
let clientA: Client;

const dbOf = (i: 0 | 1) => openPortalDb(tenants[i]!.dbPath);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-contact-sso-'));
  fake = await FakeProvider.create();
  tenants = [1, 2].map((n) => ({
    tenantId: n,
    host: n === 1 ? HOST_A : HOST_B,
    dbPath: join(dir, `t${n}`, 'portal.sqlite'),
    storageRoot: join(dir, `t${n}`, 'storage'),
  }));
  for (const t of tenants) mkdirSync(join(t.dbPath, '..'), { recursive: true });
  const a = openPortalDb(tenants[0]!.dbPath);
  clientA = createClient(a, 'Client A', 'client-a@example.com', 'a-client-token');
  a.close();
  const b = openPortalDb(tenants[1]!.dbPath);
  createClient(b, 'Client B', 'client-b@example.com', 'b-client-token');
  b.close();
  const config: PortalConfig = {
    port: 0,
    dbPath: join(dir, 'unused.sqlite'),
    storageRoot: join(dir, 'unused'),
    currency: 'USD',
    smtp: undefined,
    sso: {
      callbackOrigin: `http://${AUTH}`,
      providers: {
        google: { clientId: CLIENT_IDS.google, clientSecret: CLIENT_SECRETS.google },
      },
    },
  };
  gateway = await buildGateway({
    config,
    tenants,
    logger: false,
    sso: { http: fake.http },
  });
});

afterEach(async () => {
  await gateway.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A request as the gateway would route it: `null` is its fixed 404. */
async function send(
  host: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  token?: string,
) {
  const app = gateway.routeFor(host, method, url);
  if (!app)
    return { statusCode: 404, json: () => ({}), headers: {} as Record<string, unknown> };
  return app.inject({
    method,
    url,
    headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

let codes = 0;

/** The whole flow on a host: start, the provider, the callback host, and the redeem. */
async function signIn(host: string, subject: string, link?: string) {
  const started = await send(host, 'POST', '/api/client/sso/start', {
    provider: 'google',
    binding: BINDING,
    ...(link ? { link } : {}),
  });
  expect(started.statusCode).toBe(200);
  const url = new URL((started.json() as { url: string }).url);
  const state = url.searchParams.get('state')!;
  codes += 1;
  const code = `provider-code-${codes}`;
  fake.issueCode(
    code,
    await fake.idToken({
      provider: 'google',
      subject,
      nonce: url.searchParams.get('nonce')!,
    }),
  );
  const back = await send(
    AUTH,
    'GET',
    `/api/client/sso/callback?code=${code}&state=${encodeURIComponent(state)}`,
  );
  expect(back.statusCode).toBe(302);
  const location = String(back.headers.location);
  expect(location.startsWith(`http://${host}/client.html#sso=`)).toBe(true);
  const handoff = location.split('#sso=')[1]!;
  return send(host, 'POST', '/api/client/sso/redeem', {
    code: handoff,
    binding: BINDING,
    ...(link ? { link } : {}),
  });
}

function contactWithLink(
  email = 'pat@client.example',
  link = 'contact-link-token-0123456789',
) {
  const db = dbOf(0);
  const contact = createContact(db, clientA.id, email);
  issueContactSigninLink(db, clientA.id, contact.id, link);
  db.close();
  return { contact, link };
}

describe('a client contact signing in (issue #342)', () => {
  it('links its identity through the one-time link, then signs in and sees its client’s orders', async () => {
    const { link } = contactWithLink();
    const linked = await signIn(HOST_A, 'g-pat', link);
    expect(linked.statusCode).toBe(200);
    const session = (linked.json() as { token: string }).token;
    const me = await send(HOST_A, 'GET', '/api/client/me', undefined, session);
    expect(me.statusCode).toBe(200);
    expect((me.json() as { id: number }).id).toBe(clientA.id);
    // later, with no link: matched on the identity alone
    const again = await signIn(HOST_A, 'g-pat');
    expect(again.statusCode).toBe(200);
    // the link is spent
    const reuse = await send(HOST_A, 'POST', '/api/client/sso/start', {
      provider: 'google',
      binding: BINDING,
      link,
    });
    expect(reuse.statusCode).toBe(404);
  });

  it('is one refusal for an unmatched identity, a disabled contact and another tenant’s host', async () => {
    const { contact, link } = contactWithLink();
    await signIn(HOST_A, 'g-pat', link);
    const stranger = await signIn(HOST_A, 'g-stranger');
    expect(stranger.statusCode).toBe(401);
    expect(stranger.json()).toEqual(REFUSED);
    const elsewhere = await signIn(HOST_B, 'g-pat');
    expect(elsewhere.statusCode).toBe(401);
    expect(elsewhere.json()).toEqual(REFUSED);
    const db = dbOf(0);
    setContactDisabled(db, clientA.id, contact.id, true);
    db.close();
    const disabled = await signIn(HOST_A, 'g-pat');
    expect(disabled.json()).toEqual(REFUSED);
  });

  it('answers the callback only on the callback host, for the tenant its state names', async () => {
    expect((await send(AUTH, 'GET', '/api/client/me')).statusCode).toBe(404);
    expect(
      (
        await send(
          AUTH,
          'GET',
          '/api/client/sso/callback?state=9.abcdefghijklmnopqrstuvwxyz',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await send(
          HOST_A,
          'GET',
          '/api/client/sso/callback?state=1.abcdefghijklmnopqrstuvwxyz',
        )
      ).statusCode,
    ).toBe(404);
  });

  it('keeps the private link working until the admin turns it off, and then refuses it', async () => {
    expect(
      (await send(HOST_A, 'GET', '/api/client/me', undefined, 'a-client-token'))
        .statusCode,
    ).toBe(200);
    const { link } = contactWithLink();
    await signIn(HOST_A, 'g-pat', link);
    const db = dbOf(0);
    setClientLinkEnabled(db, clientA.id, false);
    db.close();
    expect(
      (await send(HOST_A, 'GET', '/api/client/me', undefined, 'a-client-token'))
        .statusCode,
    ).toBe(401);
    const session = ((await signIn(HOST_A, 'g-pat')).json() as { token: string }).token;
    expect(
      (await send(HOST_A, 'GET', '/api/client/me', undefined, session)).statusCode,
    ).toBe(200);
  });
});
