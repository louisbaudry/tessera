import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_FUZZY_THRESHOLD, FUZZY_FLOOR, FUZZY_MAX_SCORE } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';

import {
  FUZZY_THRESHOLD_SETTING,
  FuzzySettingError,
  getFuzzyThreshold,
  setFuzzyThreshold,
} from './fuzzy-settings.js';
import { openProjectDb } from './index.js';

let dir: string;
const open = (): Database.Database => {
  dir = mkdtempSync(join(tmpdir(), 'cat-fuzzy-setting-'));
  return openProjectDb(join(dir, 'project.catdb'));
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const settingEvents = (db: Database.Database) =>
  listEvents(db, { subjectType: 'project' }).filter(
    (e) => e.action === 'project.setting_changed',
  );

describe('the project fuzzy threshold', () => {
  it('is the default until set, and a project without a row is untouched', () => {
    const db = open();
    expect(getFuzzyThreshold(db)).toBe(DEFAULT_FUZZY_THRESHOLD);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fuzzy_setting').get()).toEqual({ n: 0 });
    db.close();
  });

  it('sets a score, off, and the default again, logging each change once', () => {
    const db = open();
    expect(setFuzzyThreshold(db, 90, TEST_ACTOR)).toBe(90);
    expect(getFuzzyThreshold(db)).toBe(90);
    expect(setFuzzyThreshold(db, null, TEST_ACTOR)).toBeNull();
    expect(getFuzzyThreshold(db)).toBeNull();
    expect(setFuzzyThreshold(db, 'default', TEST_ACTOR)).toBe(DEFAULT_FUZZY_THRESHOLD);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fuzzy_setting').get()).toEqual({ n: 0 });

    const events = settingEvents(db);
    expect(events).toHaveLength(3);
    expect(events.map((e) => JSON.parse(e.detail as string))).toEqual([
      { key: FUZZY_THRESHOLD_SETTING, from: 75, to: 90 },
      { key: FUZZY_THRESHOLD_SETTING, from: 90, to: null },
      { key: FUZZY_THRESHOLD_SETTING, from: null, to: 75 },
    ]);
    db.close();
  });

  it('writes and logs nothing when the choice changes nothing', () => {
    const db = open();
    setFuzzyThreshold(db, 'default', TEST_ACTOR);
    setFuzzyThreshold(db, 75, TEST_ACTOR); // an explicit 75 is a row, but the same in force
    expect(settingEvents(db)).toHaveLength(0);
    setFuzzyThreshold(db, 75, TEST_ACTOR);
    expect(settingEvents(db)).toHaveLength(0);
    db.close();
  });

  it('refuses anything outside the range, and a half score', () => {
    const db = open();
    for (const bad of [FUZZY_FLOOR - 1, FUZZY_MAX_SCORE + 1, 75.5, Number.NaN]) {
      expect(() => setFuzzyThreshold(db, bad, TEST_ACTOR)).toThrow(FuzzySettingError);
    }
    expect(getFuzzyThreshold(db)).toBe(DEFAULT_FUZZY_THRESHOLD);
    expect(settingEvents(db)).toHaveLength(0);
    db.close();
  });

  it("holds the migration's literal range to the constants", () => {
    // The CHECK is a frozen snapshot (migrations never read a live value);
    // this is the one place that ties it to the scorer's floor and top score.
    const db = open();
    const put = (n: number) =>
      db
        .prepare('INSERT OR REPLACE INTO fuzzy_setting (id, threshold) VALUES (1, ?)')
        .run(n);
    expect(() => put(FUZZY_FLOOR)).not.toThrow();
    expect(() => put(FUZZY_MAX_SCORE)).not.toThrow();
    expect(() => put(FUZZY_FLOOR - 1)).toThrow(/CHECK/);
    expect(() => put(FUZZY_MAX_SCORE + 1)).toThrow(/CHECK/);
    db.close();
  });

  it('is one row at most', () => {
    const db = open();
    setFuzzyThreshold(db, 80, TEST_ACTOR);
    expect(() =>
      db.prepare('INSERT INTO fuzzy_setting (id, threshold) VALUES (2, 80)').run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});
