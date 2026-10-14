/**
 * The draft engine a project asks for (backlog #133, translation-engine-spec
 * D8): absence is "inherit", `off` is an explicit answer, and a change is one
 * `project.setting_changed` in the project's log.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import {
  ENGINE_OVERRIDE_SETTING,
  EngineOverrideError,
  getEngineOverride,
  setEngineOverride,
} from './engine-override.js';
import { openProjectDb } from './index.js';

let dir: string;
const open = (): Database.Database => {
  dir = mkdtempSync(join(tmpdir(), 'cat-engine-override-'));
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
    )
    .filter((d) => d.key === ENGINE_OVERRIDE_SETTING);

describe('a project’s engine override', () => {
  it('is none until it is set, so an existing project inherits and sends nothing new', () => {
    const db = open();
    expect(getEngineOverride(db)).toBeNull();
    db.close();
  });

  it('holds off as an answer of its own, distinct from none', () => {
    const db = open();
    setEngineOverride(db, 'off', TEST_ACTOR);
    expect(getEngineOverride(db)).toBe('off');
    db.close();
  });

  it('holds an engine, and clears back to inherit with null', () => {
    const db = open();
    setEngineOverride(db, 'deepl', TEST_ACTOR);
    expect(getEngineOverride(db)).toBe('deepl');
    setEngineOverride(db, null, TEST_ACTOR);
    expect(getEngineOverride(db)).toBeNull();
    db.close();
  });

  it('logs from and to, and nothing for a change that changes nothing', () => {
    const db = open();
    setEngineOverride(db, 'tessera', TEST_ACTOR);
    setEngineOverride(db, 'tessera', TEST_ACTOR);
    setEngineOverride(db, 'off', TEST_ACTOR);
    setEngineOverride(db, null, TEST_ACTOR);
    expect(settingEvents(db)).toEqual([
      { key: ENGINE_OVERRIDE_SETTING, from: null, to: 'tessera' },
      { key: ENGINE_OVERRIDE_SETTING, from: 'tessera', to: 'off' },
      { key: ENGINE_OVERRIDE_SETTING, from: 'off', to: null },
    ]);
    db.close();
  });

  it('refuses a value that is not an engine choice', () => {
    const db = open();
    expect(() => setEngineOverride(db, 'claude' as never, TEST_ACTOR)).toThrow(
      EngineOverrideError,
    );
    expect(getEngineOverride(db)).toBeNull();
    expect(settingEvents(db)).toEqual([]);
    db.close();
  });
});
