/**
 * The CAT app's password recovery (issue #364, `planning/v1-spec.md` §4.1a), driven through the real
 * login route: the old password and the old sessions must stop working, the new password must work,
 * and nothing else about the account moves.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import { createAccount, listEvents, openPlatformDb, verifyAudit } from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecoveryError, resetAccountPassword } from './account-recovery.js';
import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const OPERATOR: AuditActor = {
  actor: { kind: 'cli', name: 'operator' },
  label: 'operator',
};

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-recovery-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  createAccount(platform, {
    email: 'alice@example.com',
    passwordHash: hashPassword('lost-password-1'),
    actor: SETUP,
  });
  createAccount(platform, {
    email: 'bob@example.com',
    passwordHash: hashPassword('bobs-password-1'),
    actor: SETUP,
  });
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
const me = (token: string) =>
  app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${token}` },
  });

describe('reset-account-password', () => {
  it('lets the person in with the new password and nobody in with the old one', async () => {
    const before = (await login('alice@example.com', 'lost-password-1')).json() as {
      token: string;
    };
    const bobToken = (
      (await login('bob@example.com', 'bobs-password-1')).json() as {
        token: string;
      }
    ).token;
    expect((await me(before.token)).statusCode).toBe(200);

    const result = resetAccountPassword({
      dbPath: config.dbPath,
      email: 'alice@example.com',
      password: 'a-brand-new-passphrase',
      actor: OPERATOR,
    });

    expect(result.sessionsEnded).toBe(1);
    expect((await me(before.token)).statusCode).toBe(401);
    expect((await login('alice@example.com', 'lost-password-1')).statusCode).toBe(401);
    expect((await login('alice@example.com', 'a-brand-new-passphrase')).statusCode).toBe(
      200,
    );
    // Someone else's password and session are untouched.
    expect((await me(bobToken)).statusCode).toBe(200);
    expect((await login('bob@example.com', 'bobs-password-1')).statusCode).toBe(200);
  });

  it('logs who ran it and keeps the chain intact', () => {
    resetAccountPassword({
      dbPath: config.dbPath,
      email: 'alice@example.com',
      password: 'a-brand-new-passphrase',
      actor: OPERATOR,
    });
    const db = openPlatformDb(config.dbPath);
    const reset = listEvents(db, { subjectType: 'account' }).filter(
      (e) => e.action === 'account.password_reset',
    );
    expect(reset).toHaveLength(1);
    expect(reset[0]!.actorLabel).toBe('operator');
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });

  it('refuses a short password, an unknown address and a missing file, writing nothing', () => {
    const run = (over: Partial<Parameters<typeof resetAccountPassword>[0]>) =>
      resetAccountPassword({
        dbPath: config.dbPath,
        email: 'alice@example.com',
        password: 'a-brand-new-passphrase',
        actor: OPERATOR,
        ...over,
      });
    expect(() => run({ password: 'short' })).toThrow(RecoveryError);
    expect(() => run({ email: 'nobody@example.com' })).toThrow(
      'no account has this address',
    );
    expect(() => run({ dbPath: join(dir, 'typo.sqlite') })).toThrow(
      /no platform database/,
    );
    const db = openPlatformDb(config.dbPath);
    expect(
      listEvents(db, { subjectType: 'account' }).some(
        (e) => e.action === 'account.password_reset',
      ),
    ).toBe(false);
    db.close();
  });
});
