/**
 * An owner invites a vendor through the routes (backlog #111): the owner creates a
 * link, the invitee opens it and sets a password without a session, and lands as a
 * signed-in vendor with the owner's roster entry in place. A link that is used,
 * withdrawn, expired or invented is one identical 404.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  acceptInvitation,
  createAccount,
  createInvitation,
  openPlatformDb,
  type Account,
} from '@cat-tool/db';
import { INVITATION_TTL_MS } from '@cat-tool/vendor-core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const PASSWORD = 'a long enough password';

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-invitations-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, role?: 'vendor') =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...(role ? { role } : {}),
    });
  alice = make('alice');
  make('dave');
  make('vera', 'vendor');
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}

const invite = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/invitations', headers: as(token), payload });
const open = (token: string) =>
  app.inject({ method: 'POST', url: '/api/invitations/open', payload: { token } });
const accept = (token: string, password: string = PASSWORD) =>
  app.inject({
    method: 'POST',
    url: '/api/invitations/accept',
    payload: { token, password },
  });

/** Alice invites bob; returns the link's token. */
async function aliceInvitesBob(displayName = 'Bob'): Promise<string> {
  const res = await invite(await login('alice'), {
    email: 'Bob@Example.com',
    displayName,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { token: string }).token;
}

describe('the gate', () => {
  it('lets the invitee open and accept without a session, and nothing else of this surface', async () => {
    expect((await open('nonsense')).statusCode).toBe(404); // reached the route, not a 401
    expect((await accept('nonsense')).statusCode).toBe(404);
    for (const [method, url] of [
      ['GET', '/api/invitations'],
      ['POST', '/api/invitations'],
      ['POST', '/api/invitations/1/revoke'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(
        401,
      );
    }
  });
});

describe('an owner invites a vendor', () => {
  it('creates a link whose token is shown once, and lists it as pending without it', async () => {
    const a = await login('alice');
    const res = await invite(a, { email: ' Bob@Example.com ', displayName: 'Bob' });
    expect(res.statusCode).toBe(201);
    const { token, invitation } = res.json() as {
      token: string;
      invitation: Record<string, unknown>;
    };
    expect(token.length).toBeGreaterThan(30);
    expect(invitation).toMatchObject({
      email: 'bob@example.com',
      displayName: 'Bob',
      status: 'pending',
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/invitations',
      headers: as(a),
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect(list.json()).toMatchObject({
      invitations: [{ email: 'bob@example.com', status: 'pending' }],
    });
  });

  it('refuses a bad address with a 400, and a vendor account as inviter', async () => {
    const a = await login('alice');
    expect((await invite(a, { email: 'nope' })).statusCode).toBe(400);
    expect((await invite(a, { email: 5 })).statusCode).toBe(400);
    expect((await invite(a, { email: 'x@example.com', displayName: 7 })).statusCode).toBe(
      400,
    );
    const v = await login('vera');
    expect((await invite(v, { email: 'x@example.com' })).statusCode).toBe(400);
  });

  it('shows each owner only their own invitations', async () => {
    await aliceInvitesBob();
    const d = await login('dave');
    const list = await app.inject({
      method: 'GET',
      url: '/api/invitations',
      headers: as(d),
    });
    expect(list.json()).toEqual({ invitations: [] });
  });
});

describe('the invitee follows the link', () => {
  it('opens it to the address, sets a password, and lands a signed-in vendor on the roster', async () => {
    const token = await aliceInvitesBob('Bob B.');
    const opened = await open(token);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ email: 'bob@example.com' });

    const res = await accept(token);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as {
      token: string;
      account: { id: number; email: string; role: string };
    };
    expect(body.account).toMatchObject({ email: 'bob@example.com', role: 'vendor' });
    expect(body.account).not.toHaveProperty('passwordHash');

    // the session works, as a vendor, and the owner's roster lists them
    const bob = as(body.token);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bob });
    expect(me.json()).toMatchObject({ role: 'vendor', email: 'bob@example.com' });
    const capacity = await app.inject({
      method: 'GET',
      url: '/api/vendor/capacity',
      headers: bob,
    });
    expect(capacity.json()).toMatchObject({ rosters: [{ owner: alice.id }] });
    const feed = await app.inject({
      method: 'GET',
      url: '/api/vendor/feed',
      headers: bob,
    });
    expect(feed.statusCode).toBe(200);
    const roster = await app.inject({
      method: 'GET',
      url: '/api/vendors',
      headers: as(await login('alice')),
    });
    expect(roster.json()).toMatchObject({
      vendors: [{ accountId: body.account.id, displayName: 'Bob B.' }],
    });

    // and the password they chose is the one that signs them in
    const again = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'bob@example.com', password: PASSWORD },
    });
    expect(again.statusCode).toBe(200);
  });

  it('refuses a short password and leaves the link usable', async () => {
    const token = await aliceInvitesBob();
    const res = await accept(token, 'short');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/at least/) });
    expect((await open(token)).statusCode).toBe(200);
    expect((await accept(token)).statusCode).toBe(201);
  });

  it('is single-use: a second accept is the same 404 as a link that never existed', async () => {
    const token = await aliceInvitesBob();
    expect((await accept(token)).statusCode).toBe(201);
    const second = await accept(token, 'another long password');
    const never = await accept('never-issued');
    expect(second.statusCode).toBe(404);
    expect(second.body).toBe(never.body);
    expect((await open(token)).statusCode).toBe(404);
  });

  it('refuses a withdrawn link, with the stranger’s identical answer', async () => {
    const a = await login('alice');
    const token = await aliceInvitesBob();
    const [inv] = (
      (
        await app.inject({ method: 'GET', url: '/api/invitations', headers: as(a) })
      ).json() as {
        invitations: Array<{ id: number }>;
      }
    ).invitations;
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/invitations/${inv!.id}/revoke`,
      headers: as(a),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ invitation: { status: 'revoked' } });
    expect((await open(token)).statusCode).toBe(404);
    const refused = await accept(token);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toBe((await accept('never-issued')).body);
  });

  it('refuses an expired link', async () => {
    const platform = openPlatformDb(config.dbPath);
    const { token } = createInvitation(platform, {
      ownerId: alice.id,
      email: 'old@example.com',
      actor: SETUP,
      now: new Date(Date.now() - INVITATION_TTL_MS - 1000),
    });
    platform.close();
    expect((await open(token)).statusCode).toBe(404);
    expect((await accept(token)).statusCode).toBe(404);
  });

  it('tells the invitee, never the owner, that the address already has an account', async () => {
    const a = await login('alice');
    const res = await invite(a, { email: 'dave@example.com' });
    expect(res.statusCode).toBe(201); // identical to any other address
    const token = (res.json() as { token: string }).token;
    const taken = await accept(token);
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: expect.stringMatching(/sign in/) });
    expect((await open(token)).statusCode).toBe(200); // still pending
  });
});

describe('an existing vendor joins a second owner’s roster (backlog #187)', () => {
  const join = (session: string | null, token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/invitations/join',
      headers: session === null ? {} : as(session),
      payload: { token },
    });

  /** Alice invites vera, who already has a vendor account. */
  async function aliceInvitesVera(): Promise<string> {
    const res = await invite(await login('alice'), {
      email: 'vera@example.com',
      displayName: 'Vera V.',
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { token: string }).token;
  }

  it('is told to sign in when the address has an account, and then joins signed in', async () => {
    const token = await aliceInvitesVera();
    const refused = await accept(token);
    expect(refused.statusCode).toBe(409);
    expect((await open(token)).statusCode).toBe(200); // still pending

    const vera = await login('vera');
    const joined = await join(vera, token);
    expect(joined.statusCode, joined.body).toBe(201);

    // vera now lists alice's roster, with the name alice gave her, and the link is spent
    const capacity = await app.inject({
      method: 'GET',
      url: '/api/vendor/capacity',
      headers: as(vera),
    });
    expect(capacity.json()).toMatchObject({ rosters: [{ owner: alice.id }] });
    const roster = await app.inject({
      method: 'GET',
      url: '/api/vendors',
      headers: as(await login('alice')),
    });
    expect(roster.json()).toMatchObject({
      vendors: [{ displayName: 'Vera V.' }],
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/invitations',
      headers: as(await login('alice')),
    });
    expect(list.json()).toMatchObject({ invitations: [{ status: 'accepted' }] });
    expect((await join(vera, token)).statusCode).toBe(404);
    expect((await open(token)).statusCode).toBe(404);
  });

  it('never attaches anyone from the link alone', async () => {
    const token = await aliceInvitesVera();
    expect((await join(null, token)).statusCode).toBe(401);
    expect((await open(token)).statusCode).toBe(200);
  });

  it('refuses a session that is not the invited address, as an unusable link', async () => {
    const token = await aliceInvitesVera();
    const stranger = await join(await login('dave'), token);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).toBe((await join(await login('dave'), 'never-issued')).body);
    expect((await open(token)).statusCode).toBe(200); // still pending, for vera
  });

  it('refuses an owner’s account with a 409 and leaves the link pending', async () => {
    const created = await invite(await login('alice'), { email: 'dave@example.com' });
    const token = (created.json() as { token: string }).token;
    const res = await join(await login('dave'), token);
    expect(res.statusCode).toBe(409);
    expect((await open(token)).statusCode).toBe(200);
  });

  it('refuses a bad body', async () => {
    expect((await join(await login('vera'), '')).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/invitations/join',
          headers: as(await login('vera')),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('the log', () => {
  it('never holds the link’s token or the password chosen with it (backlog #111)', async () => {
    const lines: string[] = [];
    const logged = await buildApp({
      config,
      logger: {
        level: 'trace',
        stream: { write: (line: string) => void lines.push(line) },
      },
    });
    try {
      const login = await logged.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'alice@example.com', password: 'alice-pw' },
      });
      const session = (login.json() as { token: string }).token;
      const created = await logged.inject({
        method: 'POST',
        url: '/api/invitations',
        headers: as(session),
        payload: { email: 'bob@example.com' },
      });
      const { token } = created.json() as { token: string };
      const password = 'the password nobody may log';
      const done = await logged.inject({
        method: 'POST',
        url: '/api/invitations/accept',
        payload: { token, password },
      });
      expect(done.statusCode, done.body).toBe(201);
      const everything = lines.join('\n');
      expect(everything).toContain('/api/invitations/accept'); // the requests were logged
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(password);
    } finally {
      await logged.close();
    }
  });
});

describe('revoking', () => {
  it('is the owner’s alone: another owner and a missing id get the same 404', async () => {
    const a = await login('alice');
    await aliceInvitesBob();
    const d = await login('dave');
    const revoke = (token: string, id: string) =>
      app.inject({
        method: 'POST',
        url: `/api/invitations/${id}/revoke`,
        headers: as(token),
      });
    expect((await revoke(d, '1')).statusCode).toBe(404);
    expect((await revoke(a, '999')).statusCode).toBe(404);
    expect((await revoke(a, 'abc')).statusCode).toBe(404);
    expect((await revoke(a, '1')).statusCode).toBe(200);
    expect((await revoke(a, '1')).statusCode).toBe(409); // already withdrawn
  });
});

describe('a roster file the accept could not reach', () => {
  it('is brought level when the owner next lists their invitations', async () => {
    // The platform half happened (account, index row, used link); the roster file did not.
    const platform = openPlatformDb(config.dbPath);
    const { token } = createInvitation(platform, {
      ownerId: alice.id,
      email: 'late@example.com',
      displayName: 'Late',
      actor: SETUP,
    });
    const { account } = acceptInvitation(platform, {
      token,
      passwordHash: hashPassword(PASSWORD),
    });
    platform.close();

    const a = await login('alice');
    const before = await app.inject({
      method: 'GET',
      url: '/api/vendors',
      headers: as(a),
    });
    expect(before.json()).toEqual({ vendors: [] });
    await app.inject({ method: 'GET', url: '/api/invitations', headers: as(a) });
    const after = await app.inject({
      method: 'GET',
      url: '/api/vendors',
      headers: as(a),
    });
    expect(after.json()).toMatchObject({
      vendors: [{ accountId: account.id, displayName: 'Late' }],
    });
    // and a second listing adds nothing twice
    await app.inject({ method: 'GET', url: '/api/invitations', headers: as(a) });
    const twice = await app.inject({
      method: 'GET',
      url: '/api/vendors',
      headers: as(a),
    });
    expect((twice.json() as { vendors: unknown[] }).vendors).toHaveLength(1);
  });
});
