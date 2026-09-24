import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword } from '@cat-tool/portal-core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';

import {
  createAdminSession,
  createAdminUser,
  deleteAdminSession,
  getAdminUserByEmail,
  getAdminUserBySessionToken,
  openPortalDb,
} from './index.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-admin-'));
  return join(dir, 'portal.sqlite');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('admin_user / admin_session repository', () => {
  it('creates an admin user and looks it up by email', () => {
    const db = openPortalDb(dbPath());
    const admin = createAdminUser(db, 'admin@optime.services', hashPassword('hunter2'));
    expect(getAdminUserByEmail(db, 'admin@optime.services')).toMatchObject({
      id: admin.id,
      email: 'admin@optime.services',
    });
    expect(getAdminUserByEmail(db, 'nobody@optime.services')).toBeNull();
    db.close();
  });

  it('enforces one admin user per email', () => {
    const db = openPortalDb(dbPath());
    createAdminUser(db, 'admin@optime.services', hashPassword('hunter2'));
    expect(() =>
      createAdminUser(db, 'admin@optime.services', hashPassword('other')),
    ).toThrow();
    db.close();
  });

  it('resolves a valid session token to its admin user', () => {
    const db = openPortalDb(dbPath());
    const admin = createAdminUser(db, 'admin@optime.services', hashPassword('hunter2'));
    createAdminSession(db, admin.id, 'a-session-token', { actor: TEST_ACTOR });
    expect(getAdminUserBySessionToken(db, 'a-session-token')).toMatchObject({
      id: admin.id,
    });
    expect(getAdminUserBySessionToken(db, 'a-wrong-token')).toBeNull();
    db.close();
  });

  it('rejects an expired session', () => {
    const db = openPortalDb(dbPath());
    const admin = createAdminUser(db, 'admin@optime.services', hashPassword('hunter2'));
    const past = new Date('2020-01-01T00:00:00Z');
    createAdminSession(db, admin.id, 'a-session-token', {
      actor: TEST_ACTOR,
      now: past,
    });
    expect(
      getAdminUserBySessionToken(db, 'a-session-token', new Date('2026-01-01T00:00:00Z')),
    ).toBeNull();
    db.close();
  });

  it('revokes a session on logout', () => {
    const db = openPortalDb(dbPath());
    const admin = createAdminUser(db, 'admin@optime.services', hashPassword('hunter2'));
    createAdminSession(db, admin.id, 'a-session-token', { actor: TEST_ACTOR });
    deleteAdminSession(db, 'a-session-token');
    expect(getAdminUserBySessionToken(db, 'a-session-token')).toBeNull();
    db.close();
  });
});
