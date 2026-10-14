/**
 * A client's consent to draft engines (backlog #133, translation-engine-spec
 * D4, D9, D19): absence is "no consent", every change is audited with an
 * actor, and withdrawing consent takes the default with it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveEngine } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { createAccount, type Account } from './accounts.js';
import {
  ClientEngineError,
  getClientEngine,
  setClientEngineConsent,
  setClientEngineDefault,
} from './client-engine.js';
import { openPlatformDb } from './index.js';

let dir: string;
let db: Database.Database;
let owner: Account;
let otherOwner: Account;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-client-engine-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  owner = createAccount(db, {
    email: 'a@example.test',
    passwordHash: 'h',
    actor: TEST_ACTOR,
  });
  otherOwner = createAccount(db, {
    email: 'b@example.test',
    passwordHash: 'h',
    actor: TEST_ACTOR,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const consent = (
  engine: 'tessera' | 'deepl',
  on: boolean,
  clientId = 7,
  ownerId = owner.id,
) =>
  setClientEngineConsent(db, {
    ownerId,
    clientId,
    engine,
    consent: on,
    actor: TEST_ACTOR,
  });

const changes = () =>
  listEvents(db, { subjectType: 'client' }).filter(
    (e) => e.action === 'client_engine.changed',
  );

describe('a client nobody has set anything for', () => {
  it('has consented to nothing and defaults to off', () => {
    expect(getClientEngine(db, owner.id, 7)).toEqual({ default: 'off', consented: [] });
  });

  it('writes nothing to the audit log just by being read', () => {
    getClientEngine(db, owner.id, 7);
    expect(changes()).toHaveLength(0);
  });
});

describe('setClientEngineConsent', () => {
  it('records consent per engine and logs from and to', () => {
    consent('tessera', true);
    expect(getClientEngine(db, owner.id, 7).consented).toEqual(['tessera']);
    const [e] = changes();
    expect(e!.action).toBe('client_engine.changed');
    expect(JSON.parse(e!.detail!)).toEqual({
      client_id: 7,
      key: 'consent:tessera',
      from: false,
      to: true,
    });
    expect(e!.subjectType).toBe('client');
    expect(e!.subjectId).toBe('7');
  });

  it('does not let consent to one engine stand for another', () => {
    consent('tessera', true);
    expect(getClientEngine(db, owner.id, 7).consented).not.toContain('deepl');
  });

  it('is a no-op, writing and logging nothing, when nothing changes', () => {
    consent('tessera', true);
    consent('tessera', true);
    consent('deepl', false);
    expect(changes()).toHaveLength(1);
  });

  it('keeps one owner’s client apart from another owner’s same number', () => {
    consent('tessera', true, 7, owner.id);
    expect(getClientEngine(db, otherOwner.id, 7).consented).toEqual([]);
  });

  it('names who did it, from the actor it was given', () => {
    consent('tessera', true);
    expect(changes()[0]!.actor).toBe('cli:test');
  });

  it('refuses a client number that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => consent('tessera', true, bad)).toThrow(ClientEngineError);
    }
    expect(changes()).toHaveLength(0);
  });

  it('refuses an engine that sends nothing out, or an unknown one', () => {
    expect(() =>
      setClientEngineConsent(db, {
        ownerId: owner.id,
        clientId: 7,
        engine: 'off' as never,
        consent: true,
        actor: TEST_ACTOR,
      }),
    ).toThrow(ClientEngineError);
    expect(() =>
      setClientEngineConsent(db, {
        ownerId: owner.id,
        clientId: 7,
        engine: 'claude' as never,
        consent: true,
        actor: TEST_ACTOR,
      }),
    ).toThrow(ClientEngineError);
  });

  it('refuses an owner that does not exist', () => {
    expect(() => consent('tessera', true, 7, 9999)).toThrow(ClientEngineError);
  });
});

describe('setClientEngineDefault', () => {
  it('needs consent first: a default can never name an engine nobody agreed to', () => {
    expect(() =>
      setClientEngineDefault(db, {
        ownerId: owner.id,
        clientId: 7,
        engine: 'tessera',
        actor: TEST_ACTOR,
      }),
    ).toThrow(ClientEngineError);
    expect(getClientEngine(db, owner.id, 7).default).toBe('off');
    expect(changes()).toHaveLength(0);
  });

  it('sets the default once consented, and logs it', () => {
    consent('deepl', true);
    setClientEngineDefault(db, {
      ownerId: owner.id,
      clientId: 7,
      engine: 'deepl',
      actor: TEST_ACTOR,
    });
    expect(getClientEngine(db, owner.id, 7)).toEqual({
      default: 'deepl',
      consented: ['deepl'],
    });
    const last = changes().at(-1)!;
    expect(JSON.parse(last.detail!)).toEqual({
      client_id: 7,
      key: 'default',
      from: 'off',
      to: 'deepl',
    });
  });

  it('turns back to off without needing anything', () => {
    consent('tessera', true);
    setClientEngineDefault(db, {
      ownerId: owner.id,
      clientId: 7,
      engine: 'tessera',
      actor: TEST_ACTOR,
    });
    setClientEngineDefault(db, {
      ownerId: owner.id,
      clientId: 7,
      engine: 'off',
      actor: TEST_ACTOR,
    });
    expect(getClientEngine(db, owner.id, 7).default).toBe('off');
  });
});

describe('withdrawing consent', () => {
  it('takes the default with it, in the same transaction, and logs both', () => {
    consent('tessera', true);
    setClientEngineDefault(db, {
      ownerId: owner.id,
      clientId: 7,
      engine: 'tessera',
      actor: TEST_ACTOR,
    });
    const before = changes().length;
    consent('tessera', false);
    expect(getClientEngine(db, owner.id, 7)).toEqual({ default: 'off', consented: [] });
    const added = changes()
      .slice(before)
      .map((e) => JSON.parse(e.detail!).key);
    expect(added.sort()).toEqual(['consent:tessera', 'default']);
  });

  it('leaves a default on another engine alone', () => {
    consent('tessera', true);
    consent('deepl', true);
    setClientEngineDefault(db, {
      ownerId: owner.id,
      clientId: 7,
      engine: 'deepl',
      actor: TEST_ACTOR,
    });
    consent('tessera', false);
    expect(getClientEngine(db, owner.id, 7)).toEqual({
      default: 'deepl',
      consented: ['deepl'],
    });
  });

  it('makes the gate refuse at once', () => {
    consent('tessera', true);
    setClientEngineDefault(db, {
      ownerId: owner.id,
      clientId: 7,
      engine: 'tessera',
      actor: TEST_ACTOR,
    });
    const open = () =>
      resolveEngine({
        hasClient: true,
        client: getClientEngine(db, owner.id, 7),
        projectOverride: null,
      });
    expect(open()).toEqual({ engine: 'tessera' });
    consent('tessera', false);
    expect(open()).toEqual({ engine: 'off', reason: 'client_default_off' });
  });
});

describe('the audit log', () => {
  it('still verifies after a run of changes', () => {
    consent('tessera', true);
    setClientEngineDefault(db, {
      ownerId: owner.id,
      clientId: 7,
      engine: 'tessera',
      actor: TEST_ACTOR,
    });
    consent('tessera', false);
    expect(verifyAudit(db).brokenAt).toBeNull();
  });
});
