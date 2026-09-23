import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openProjectDb } from './index.js';
import {
  addUntranslatedAllowlistEntry,
  isUntranslatedAllowed,
  listUntranslatedAllowlist,
  removeUntranslatedAllowlistEntry,
} from './qa-untranslated-allowlist.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-qa-allowlist-'));
  return join(dir, 'project.catdb');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('isUntranslatedAllowed / addUntranslatedAllowlistEntry', () => {
  it('a source_hash with no row is not suppressed — absence means the rule runs', () => {
    const db = openProjectDb(dbPath());
    expect(isUntranslatedAllowed(db, 'abc123')).toBe(false);
    db.close();
  });

  it('adding an entry suppresses that exact source_hash', () => {
    const db = openProjectDb(dbPath());
    addUntranslatedAllowlistEntry(db, 'abc123');
    expect(isUntranslatedAllowed(db, 'abc123')).toBe(true);
    expect(isUntranslatedAllowed(db, 'other-hash')).toBe(false);
    db.close();
  });

  it('adding the same source_hash twice does not insert a second row', () => {
    const db = openProjectDb(dbPath());
    addUntranslatedAllowlistEntry(db, 'abc123');
    addUntranslatedAllowlistEntry(db, 'abc123');
    expect(
      db.prepare('SELECT count(*) as n FROM qa_untranslated_allowlist').get(),
    ).toEqual({ n: 1 });
    db.close();
  });
});

describe('removeUntranslatedAllowlistEntry', () => {
  it('removes a suppression so the rule runs again', () => {
    const db = openProjectDb(dbPath());
    addUntranslatedAllowlistEntry(db, 'abc123');
    removeUntranslatedAllowlistEntry(db, 'abc123');
    expect(isUntranslatedAllowed(db, 'abc123')).toBe(false);
    db.close();
  });

  it('removing a hash that was never added is a no-op', () => {
    const db = openProjectDb(dbPath());
    expect(() => removeUntranslatedAllowlistEntry(db, 'never-added')).not.toThrow();
    db.close();
  });
});

describe('listUntranslatedAllowlist', () => {
  it('lists every suppressed source_hash', () => {
    const db = openProjectDb(dbPath());
    addUntranslatedAllowlistEntry(db, 'hash-1');
    addUntranslatedAllowlistEntry(db, 'hash-2');
    const entries = listUntranslatedAllowlist(db);
    expect(entries.map((e) => e.sourceHash).sort()).toEqual(['hash-1', 'hash-2']);
    db.close();
  });
});
