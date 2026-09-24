/**
 * `platform.sqlite`'s audit log (audit-spec.md §2.5; backlog #57): the
 * shared table, and each platform write leaving exactly its one event.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSessionToken, type AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { appendAuditEvent, listEvents, verifyAudit } from '../audit/events.js';
import { createAccount, createAccountSession, deleteAccountSession } from './accounts.js';
import {
  projectSubjectId,
  recordDownload,
  recordFailedLogin,
  recordProjectChange,
} from './audit.js';
import { openPlatformDb } from './index.js';

const GATE: AuditActor = { actor: { kind: 'system', name: 'login' }, label: null };

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-platform-audit-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const allEvents = () =>
  db
    .prepare(
      'SELECT actor, actor_label, action, subject_type, subject_id, detail FROM audit_event ORDER BY id',
    )
    .all();

describe('platform audit_event', () => {
  it('admits only platform actions', () => {
    expect(() =>
      appendAuditEvent(db, {
        actor: TEST_ACTOR,
        action: 'segment.confirmed',
        subjectType: 'segment',
        subjectId: '1',
        detail: { tm_write: null },
      }),
    ).toThrow(/CHECK/);
  });

  it('records account creation with no personal data in the chain', () => {
    const account = createAccount(db, {
      email: 'a@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
    });
    expect(allEvents()).toEqual([
      {
        actor: 'cli:test',
        actor_label: 'test',
        action: 'account.created',
        subject_type: 'account',
        subject_id: String(account.id),
        detail: null,
      },
    ]);
  });

  it('records a login and a logout as acts of the account itself, in the session transaction', () => {
    const account = createAccount(db, {
      email: 'a@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
    });
    const self: AuditActor = {
      actor: { kind: 'account', id: account.id },
      label: account.email,
    };
    const token = generateSessionToken();
    createAccountSession(db, account.id, token, { actor: self });
    deleteAccountSession(db, token, { actor: self });
    deleteAccountSession(db, token, { actor: self }); // no session: nothing
    const events = listEvents(db, {
      subjectType: 'account',
      subjectId: String(account.id),
    });
    expect(events.map((e) => [e.action, e.actor, e.actorLabel])).toEqual([
      ['account.created', 'cli:test', 'test'],
      ['auth.login', `account:${account.id}`, 'a@example.com'],
      ['auth.logout', `account:${account.id}`, 'a@example.com'],
    ]);
  });

  it('records a failed login against the gate, never the account it named', () => {
    recordFailedLogin(db, { actor: GATE, accountId: 7, reason: 'wrong_password' });
    recordFailedLogin(db, { actor: GATE, accountId: null, reason: 'unknown_email' });
    expect(allEvents()).toEqual([
      {
        actor: 'system:login',
        actor_label: null,
        action: 'auth.login_failed',
        subject_type: 'account',
        subject_id: '7',
        detail: '{"reason":"wrong_password"}',
      },
      {
        actor: 'system:login',
        actor_label: null,
        action: 'auth.login_failed',
        subject_type: 'account',
        subject_id: null,
        detail: '{"reason":"unknown_email"}',
      },
    ]);
  });

  it('rolls a project event back with a change that throws', () => {
    const project = { accountId: 3, name: 'acme' };
    const path = join(dir, 'acme.catdb');
    recordProjectChange(db, 'project.created', { actor: TEST_ACTOR, project }, () =>
      writeFileSync(path, ''),
    );
    expect(() =>
      recordProjectChange(db, 'project.deleted', { actor: TEST_ACTOR, project }, () => {
        throw new Error('disk says no');
      }),
    ).toThrow('disk says no');
    expect(existsSync(path)).toBe(true);
    const events = listEvents(db, {
      subjectType: 'project',
      subjectId: projectSubjectId(project),
    });
    expect(events.map((e) => [e.action, e.subjectId])).toEqual([
      ['project.created', '3/acme'],
    ]);
  });

  it('records a download with the digest of the bytes sent, and the chain verifies', () => {
    recordDownload(db, {
      actor: TEST_ACTOR,
      project: { accountId: 3, name: 'acme' },
      fileId: 2,
      name: 'brochure.docx',
      sha256: 'ab'.repeat(32),
    });
    expect(allEvents()).toEqual([
      {
        actor: 'cli:test',
        actor_label: 'test',
        action: 'file.downloaded',
        subject_type: 'project',
        subject_id: '3/acme',
        detail: `{"file_id":2,"name":"brochure.docx","sha256":"${'ab'.repeat(32)}"}`,
      },
    ]);
    expect(verifyAudit(db)).toEqual({ events: 1, brokenAt: null });
  });
});
