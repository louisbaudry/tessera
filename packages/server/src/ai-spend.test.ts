/**
 * `GET /api/ai-spend` (issue #150): an admin reads what the tenant's draft runs spent, per
 * project and in total, in units and never in text; a pm is refused, a vendor is shown nothing,
 * and another tenant's spend is never in the answer. Accounts are made so no tenant id equals
 * its founder's account id.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  getTenantForAccount,
  openPlatformDb,
  openProjectDb,
  recordAiUsage,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { projectPath } from './storage.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let tenantA: Tenant;
let tenantB: Tenant;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-ai-spend-'));
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
  make('bob', { role: 'vendor' });
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

async function project(token: string, name: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name, srcLang: 'en', tgtLang: 'es' },
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** Records spend straight into a project's file, as a draft run would. */
function spend(
  tenant: Tenant,
  name: string,
  rows: Array<{
    engine: 'tessera' | 'deepl';
    model: string;
    unit: 'tokens' | 'characters';
    inputUnits: number;
    outputUnits: number;
    outcome: 'stored' | 'rejected' | 'discarded';
  }>,
): void {
  const db = openProjectDb(projectPath(config.storageRoot, tenant, name));
  try {
    rows.forEach((r, i) =>
      recordAiUsage(db, { segmentId: i + 1, at: '2026-11-01T00:00:00.000Z', ...r }),
    );
  } finally {
    db.close();
  }
}

const get = (token: string) =>
  app.inject({ method: 'GET', url: '/api/ai-spend', headers: as(token) });

const t = (
  inputUnits: number,
  outputUnits: number,
  outcome: 'stored' | 'rejected' = 'stored',
) => ({
  engine: 'tessera' as const,
  model: 'm-1',
  unit: 'tokens' as const,
  inputUnits,
  outputUnits,
  outcome,
});

describe('GET /api/ai-spend', () => {
  it('sums each project that spent something, and all of them together', async () => {
    const a = await login('alice');
    await project(a, 'alpha');
    await project(a, 'beta');
    await project(a, 'quiet');
    spend(tenantA, 'alpha', [t(100, 20), t(100, 20, 'rejected')]);
    spend(tenantA, 'beta', [
      t(50, 10),
      {
        engine: 'deepl',
        model: 'deepl-1',
        unit: 'characters',
        inputUnits: 300,
        outputUnits: 0,
        outcome: 'stored',
      },
    ]);

    const res = await get(a);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      projects: Array<{ name: string; usage: { calls: number; rows: unknown[] } }>;
      total: { calls: number; rows: Array<Record<string, unknown>> };
    };
    // A project with no spend is not listed; the rest are in name order.
    expect(body.projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect(body.projects[0]!.usage).toMatchObject({
      calls: 2,
      rows: [
        {
          engine: 'tessera',
          model: 'm-1',
          unit: 'tokens',
          inputUnits: 200,
          outputUnits: 40,
          stored: 1,
          rejected: 1,
        },
      ],
    });
    // The total merges by engine, model and unit, and keeps DeepL's characters apart.
    expect(body.total.calls).toBe(4);
    expect(body.total.rows).toMatchObject([
      { engine: 'deepl', unit: 'characters', inputUnits: 300 },
      { engine: 'tessera', unit: 'tokens', inputUnits: 250, outputUnits: 50, calls: 3 },
    ]);
  });

  it('answers an empty view when nothing was drafted', async () => {
    const a = await login('alice');
    await project(a, 'alpha');
    expect((await get(a)).json()).toEqual({
      projects: [],
      total: { rows: [], calls: 0 },
    });
  });

  it('never shows another tenant’s spend', async () => {
    const a = await login('alice');
    const c = await login('carol');
    await project(a, 'alpha');
    await project(c, 'gamma');
    spend(tenantB, 'gamma', [t(999, 99)]);
    const mine = (await get(a)).json() as {
      projects: unknown[];
      total: { calls: number };
    };
    expect(mine.projects).toEqual([]);
    expect(mine.total.calls).toBe(0);
    expect(JSON.stringify((await get(c)).json())).toContain('"gamma"');
  });

  it('refuses a pm with a 403, shows a vendor nothing, and needs a session', async () => {
    const pm = await get(await login('dave'));
    expect(pm.statusCode).toBe(403);
    expect(pm.json()).toEqual({ error: 'only an admin can do that' });
    const vendor = await get(await login('bob'));
    expect(vendor.statusCode).toBe(200);
    expect(vendor.json()).toEqual({ projects: [], total: { rows: [], calls: 0 } });
    expect((await app.inject({ method: 'GET', url: '/api/ai-spend' })).statusCode).toBe(
      401,
    );
  });
});
