/**
 * `GET /api/audit` (backlog #211): a tenant's admin reads their own slice of the platform
 * log and nothing of another tenant's; a pm is refused and a vendor is shown nothing.
 * Accounts are made so no tenant id equals its founder's account id.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  getTenantForAccount,
  openPlatformDb,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let tenantA: Tenant;
let tenantB: Tenant;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-tenant-audit-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, extra: Partial<Parameters<typeof createAccount>[1]> = {}) =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...extra,
    });
  make('bob', { role: 'vendor' }); // a vendor first, so no tenant id equals its founder's account id
  const alice = make('alice');
  const carol = make('carol');
  tenantA = getTenantForAccount(platform, alice.id)!.tenant;
  tenantB = getTenantForAccount(platform, carol.id)!.tenant;
  make('dave', { joinTenant: { tenantId: tenantA.id, role: 'pm' } });
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function login(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

interface Page {
  events: Array<{
    id: number;
    action: string;
    actor: string;
    actorLabel: string | null;
    subjectType: string;
    subjectId: string | null;
    detail: unknown;
  }>;
  next: number | null;
}
const audit = async (token: string, query = '') =>
  app.inject({ method: 'GET', url: `/api/audit${query}`, headers: as(token) });

describe('GET /api/audit', () => {
  it('shows an admin their own tenant’s events, newest first, and never another tenant’s', async () => {
    const a = await login('alice');
    const c = await login('carol');
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: as(a),
      payload: { name: 'a-job', srcLang: 'en', tgtLang: 'de' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: as(c),
      payload: { name: 'b-job', srcLang: 'en', tgtLang: 'de' },
    });
    const mine = (await audit(a)).json() as Page;
    const theirs = (await audit(c)).json() as Page;
    const subjects = (page: Page) => page.events.map((e) => e.subjectId);
    expect(subjects(mine)).toContain(`t${tenantA.id}/a-job`);
    expect(subjects(mine)).not.toContain(`t${tenantB.id}/b-job`);
    expect(subjects(theirs)).toContain(`t${tenantB.id}/b-job`);
    expect(subjects(theirs)).not.toContain(`t${tenantA.id}/a-job`);
    const ids = mine.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    // the staff's own sign-ins are in their tenant's slice, with the label snapshotted then
    expect(
      mine.events.some(
        (e) => e.action === 'auth.login' && e.actorLabel === 'alice@example.com',
      ),
    ).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('carol@example.com');
  });

  it('refuses a pm with a 403, and shows a vendor nothing', async () => {
    const pm = await audit(await login('dave'));
    expect(pm.statusCode).toBe(403);
    expect(pm.json()).toEqual({ error: 'only an admin can do that' });
    const vendor = await audit(await login('bob'));
    expect(vendor.statusCode).toBe(200);
    expect(vendor.json()).toEqual({ events: [], next: null });
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);
  });

  it('pages: a full page names the cursor to the next, and the last page names none', async () => {
    const a = await login('alice');
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/staff/invitations',
        headers: as(a),
        payload: { email: `p${i}@example.com`, role: 'pm' },
      });
    }
    const first = (await audit(a, '?limit=3')).json() as Page;
    expect(first.events).toHaveLength(3);
    expect(first.next).toBe(first.events[2]!.id);
    const seen = new Set(first.events.map((e) => e.id));
    let cursor = first.next;
    for (let guard = 0; cursor !== null && guard < 20; guard++) {
      const page = (await audit(a, `?limit=3&before=${cursor}`)).json() as Page;
      for (const e of page.events) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = page.next;
    }
    expect(cursor).toBeNull();
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });

  it('refuses a limit or cursor that is not a positive whole number', async () => {
    const a = await login('alice');
    for (const q of ['?limit=0', '?limit=-1', '?limit=abc', '?before=0', '?before=1.5']) {
      expect((await audit(a, q)).statusCode, q).toBe(400);
    }
  });

  it('writes nothing when read: reading the log is not an event', async () => {
    const a = await login('alice');
    const before = ((await audit(a)).json() as Page).events.length;
    await audit(a);
    await audit(a);
    expect(((await audit(a)).json() as Page).events).toHaveLength(before);
  });
});
