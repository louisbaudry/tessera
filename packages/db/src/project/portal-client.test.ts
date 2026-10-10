import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import { openProjectDb } from './index.js';
import {
  getPortalClient,
  PORTAL_CLIENT_SETTING,
  PortalClientSettingError,
  setPortalClient,
} from './portal-client.js';

let dir: string;
const open = (): Database.Database => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-client-'));
  return openProjectDb(join(dir, 'project.catdb'));
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const settingEvents = (db: Database.Database) =>
  listEvents(db, { subjectType: 'project' })
    .filter((e) => e.action === 'project.setting_changed')
    .map(
      (e) =>
        JSON.parse(e.detail as string) as { key: string; from: unknown; to: unknown },
    );

describe('the portal client a project is work for', () => {
  it('is none until it is set, so an existing project is unchanged', () => {
    const db = open();
    expect(getPortalClient(db)).toBeNull();
    db.close();
  });

  it('is set, replaced and cleared, each change logged with from and to', () => {
    const db = open();
    expect(setPortalClient(db, 7, TEST_ACTOR)).toBe(7);
    expect(setPortalClient(db, 9, TEST_ACTOR)).toBe(9);
    expect(setPortalClient(db, null, TEST_ACTOR)).toBeNull();
    expect(getPortalClient(db)).toBeNull();
    expect(settingEvents(db)).toEqual([
      { key: PORTAL_CLIENT_SETTING, from: null, to: 7 },
      { key: PORTAL_CLIENT_SETTING, from: 7, to: 9 },
      { key: PORTAL_CLIENT_SETTING, from: 9, to: null },
    ]);
    db.close();
  });

  it('writes nothing and logs nothing for a change that changes nothing', () => {
    const db = open();
    setPortalClient(db, 7, TEST_ACTOR);
    setPortalClient(db, 7, TEST_ACTOR);
    setPortalClient(db, null, TEST_ACTOR);
    setPortalClient(db, null, TEST_ACTOR);
    expect(settingEvents(db)).toHaveLength(2); // set, then cleared; the repeats are no-ops
    db.close();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses %s as a client', (bad) => {
    const db = open();
    expect(() => setPortalClient(db, bad, TEST_ACTOR)).toThrow(PortalClientSettingError);
    expect(getPortalClient(db)).toBeNull();
    db.close();
  });
});
