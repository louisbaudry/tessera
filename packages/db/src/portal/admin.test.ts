import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, verifyPassword } from '@cat-tool/portal-core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';

import {
  createAdminSession,
  createAdminUser,
  deleteAdminSession,
  getAdminUserByEmail,
  getAdminUserBySessionToken,
  openPortalDb,
  setAdminPassword,
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
    const admin = createAdminUser(db, 'admin@example.com', hashPassword('hunter2'));
    expect(getAdminUserByEmail(db, 'admin@example.com')).toMatchObject({
      id: admin.id,
      email: 'admin@example.com',
    });
    expect(getAdminUserByEmail(db, 'nobody@example.com')).toBeNull();
    db.close();
  });

  it('enforces one admin user per email', () => {
    const db = openPortalDb(dbPath());
    createAdminUser(db, 'admin@example.com', hashPassword('hunter2'));
    expect(() =>
      createAdminUser(db, 'admin@example.com', hashPassword('other')),
    ).toThrow();
    db.close();
  });

  it('resolves a valid session token to its admin user', () => {
    const db = openPortalDb(dbPath());
    const admin = createAdminUser(db, 'admin@example.com', hashPassword('hunter2'));
    createAdminSession(db, admin.id, 'a-session-token', { actor: TEST_ACTOR });
    expect(getAdminUserBySessionToken(db, 'a-session-token')).toMatchObject({
      id: admin.id,
    });
    expect(getAdminUserBySessionToken(db, 'a-wrong-token')).toBeNull();
    db.close();
  });

  it('rejects an expired session', () => {
    const db = openPortalDb(dbPath());
    const admin = createAdminUser(db, 'admin@example.com', hashPassword('hunter2'));
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
    const admin = createAdminUser(db, 'admin@example.com', hashPassword('hunter2'));
    createAdminSession(db, admin.id, 'a-session-token', { actor: TEST_ACTOR });
    deleteAdminSession(db, 'a-session-token');
    expect(getAdminUserBySessionToken(db, 'a-session-token')).toBeNull();
    db.close();
  });
});

describe('setAdminPassword (issue #364)', () => {
  it('sets the new password, ends every session of that admin and logs it', () => {
    const db = openPortalDb(dbPath());
    const admin = createAdminUser(db, 'admin@example.com', hashPassword('old-password'));
    const other = createAdminUser(
      db,
      'other@example.com',
      hashPassword('other-password'),
    );
    createAdminSession(db, admin.id, 'tok-a1', { actor: TEST_ACTOR });
    createAdminSession(db, admin.id, 'tok-a2', { actor: TEST_ACTOR });
    createAdminSession(db, other.id, 'tok-b', { actor: TEST_ACTOR });

    const result = setAdminPassword(
      db,
      'admin@example.com',
      hashPassword('new-password'),
      {
        actor: TEST_ACTOR,
      },
    );

    expect(result).toEqual({ sessionsEnded: 2 });
    const stored = getAdminUserByEmail(db, 'admin@example.com')!.passwordHash;
    expect(verifyPassword('new-password', stored)).toBe(true);
    expect(verifyPassword('old-password', stored)).toBe(false);
    // The old sessions stop working; another admin's is untouched.
    expect(getAdminUserBySessionToken(db, 'tok-a1')).toBeNull();
    expect(getAdminUserBySessionToken(db, 'tok-a2')).toBeNull();
    expect(getAdminUserBySessionToken(db, 'tok-b')?.email).toBe('other@example.com');

    const events = listEvents(db, {
      subjectType: 'admin_user',
      subjectId: String(admin.id),
    });
    const reset = events.filter((e) => e.action === 'admin.password_reset');
    expect(reset).toHaveLength(1);
    expect(JSON.parse(reset[0]!.detail as string)).toEqual({ sessions_ended: 2 });
    // Nothing personal or secret in the hashed detail.
    expect(reset[0]!.detail as string).not.toMatch(/example\.com|password/);
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });

  it('writes nothing for an address no admin has', () => {
    const db = openPortalDb(dbPath());
    createAdminUser(db, 'admin@example.com', hashPassword('old-password'));
    const before = verifyAudit(db).events;
    expect(
      setAdminPassword(db, 'nobody@example.com', hashPassword('new-password'), {
        actor: TEST_ACTOR,
      }),
    ).toBeNull();
    expect(verifyAudit(db).events).toBe(before);
    db.close();
  });
});
