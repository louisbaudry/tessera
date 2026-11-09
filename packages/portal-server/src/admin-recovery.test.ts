/**
 * The portal admin's password recovery (issue #364, `planning/portal-v0-spec.md` §7a), driven
 * through the real login route: the old password and the old session must stop working and the new
 * password must work.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditActor } from '@cat-tool/core';
import { createAdminUser, listEvents, openPortalDb, verifyAudit } from '@cat-tool/db';
import { hashPassword } from '@cat-tool/portal-core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecoveryError, resetAdminPassword } from './admin-recovery.js';
import { buildApp } from './app.js';
import type { TenantPortalConfig } from './tenants.js';

const OPERATOR: AuditActor = {
  actor: { kind: 'cli', name: 'operator' },
  label: 'operator',
};

let dir: string;
let config: TenantPortalConfig;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-recovery-'));
  config = {
    port: 0,
    dbPath: join(dir, 'portal.sqlite'),
    storageRoot: join(dir, 'storage'),
    currency: 'USD',
    smtp: undefined,
  };
  const db = openPortalDb(config.dbPath);
  createAdminUser(db, 'admin@example.com', hashPassword('lost-password-1'));
  db.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const login = (password: string) =>
  app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { email: 'admin@example.com', password },
  });
const orders = (token: string) =>
  app.inject({
    method: 'GET',
    url: '/api/admin/orders',
    headers: { authorization: `Bearer ${token}` },
  });

describe('reset-admin-password', () => {
  it('lets the admin in with the new password and nobody in with the old one', async () => {
    const token = ((await login('lost-password-1')).json() as { token: string }).token;
    expect((await orders(token)).statusCode).toBe(200);

    const result = resetAdminPassword({
      dbPath: config.dbPath,
      email: 'admin@example.com',
      password: 'a-brand-new-passphrase',
      actor: OPERATOR,
    });

    expect(result.sessionsEnded).toBe(1);
    expect((await orders(token)).statusCode).toBe(401);
    expect((await login('lost-password-1')).statusCode).toBe(401);
    expect((await login('a-brand-new-passphrase')).statusCode).toBe(200);
  });

  it('logs who ran it and keeps the chain intact', () => {
    resetAdminPassword({
      dbPath: config.dbPath,
      email: 'admin@example.com',
      password: 'a-brand-new-passphrase',
      actor: OPERATOR,
    });
    const db = openPortalDb(config.dbPath);
    const reset = listEvents(db, { subjectType: 'admin_user' }).filter(
      (e) => e.action === 'admin.password_reset',
    );
    expect(reset).toHaveLength(1);
    expect(reset[0]!.actorLabel).toBe('operator');
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });

  it('refuses a short password, an unknown address and a missing file, writing nothing', () => {
    const run = (over: Partial<Parameters<typeof resetAdminPassword>[0]>) =>
      resetAdminPassword({
        dbPath: config.dbPath,
        email: 'admin@example.com',
        password: 'a-brand-new-passphrase',
        actor: OPERATOR,
        ...over,
      });
    expect(() => run({ password: 'short' })).toThrow(RecoveryError);
    expect(() => run({ email: 'nobody@example.com' })).toThrow(
      'no admin account has this address',
    );
    expect(() => run({ dbPath: join(dir, 'typo.sqlite') })).toThrow(/no portal database/);
    const db = openPortalDb(config.dbPath);
    expect(
      listEvents(db, { subjectType: 'admin_user' }).some(
        (e) => e.action === 'admin.password_reset',
      ),
    ).toBe(false);
    db.close();
  });
});
