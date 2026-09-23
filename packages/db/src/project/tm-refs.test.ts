import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openProjectDb } from './index.js';
import {
  addTmRef,
  attachTms,
  detachTms,
  listTmRefs,
  setWriteTarget,
  tmAlias,
  TmRefError,
} from './tm-refs.js';
import { createTm } from '../tm/index.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-repo-'));
  return join(dir, 'project.catdb');
};
const ctmPath = (name: string) => join(dir, name);

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('addTmRef / listTmRefs', () => {
  it('lists references lowest-priority-first, regardless of insert order', () => {
    dbPath(); // establishes dir
    const db = openProjectDb(dbPath());
    addTmRef(db, { path: 'c.ctm', priority: 3 });
    addTmRef(db, { path: 'a.ctm', priority: 1 });
    addTmRef(db, { path: 'b.ctm', priority: 2 });
    expect(listTmRefs(db).map((r) => r.path)).toEqual(['a.ctm', 'b.ctm', 'c.ctm']);
    db.close();
  });

  it('defaults isWriteTarget/enabled sensibly', () => {
    const db = openProjectDb(dbPath());
    const ref = addTmRef(db, { path: 'a.ctm', priority: 1 });
    expect(ref.isWriteTarget).toBe(false);
    expect(ref.enabled).toBe(true);
    db.close();
  });
});

describe('setWriteTarget', () => {
  it('moves the write target atomically, never leaving zero or two', () => {
    const db = openProjectDb(dbPath());
    const a = addTmRef(db, { path: 'a.ctm', priority: 1, isWriteTarget: true });
    const b = addTmRef(db, { path: 'b.ctm', priority: 2 });

    setWriteTarget(db, b.id);
    const refs = listTmRefs(db);
    expect(refs.find((r) => r.id === a.id)!.isWriteTarget).toBe(false);
    expect(refs.find((r) => r.id === b.id)!.isWriteTarget).toBe(true);
    db.close();
  });

  it('refuses an unknown id', () => {
    const db = openProjectDb(dbPath());
    expect(() => setWriteTarget(db, 999_999)).toThrow(TmRefError);
    db.close();
  });
});

describe('attachTms / detachTms', () => {
  it('attaches every enabled TM under a stable alias, reachable by query', () => {
    const db = openProjectDb(dbPath());
    createTm(ctmPath('a.ctm'), { name: 'A', generator: 'test' }).close();
    createTm(ctmPath('b.ctm'), { name: 'B', generator: 'test' }).close();
    const a = addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });
    const b = addTmRef(db, { path: ctmPath('b.ctm'), priority: 2 });

    const attached = attachTms(db, listTmRefs(db));
    expect(attached.map((r) => r.id)).toEqual([a.id, b.id]);

    const nameA = db.prepare(`SELECT name FROM ${tmAlias(a.id)}.tm`).get() as {
      name: string;
    };
    expect(nameA.name).toBe('A');
    const nameB = db.prepare(`SELECT name FROM ${tmAlias(b.id)}.tm`).get() as {
      name: string;
    };
    expect(nameB.name).toBe('B');
    db.close();
  });

  it('skips a disabled TM', () => {
    const db = openProjectDb(dbPath());
    createTm(ctmPath('a.ctm'), { name: 'A', generator: 'test' }).close();
    addTmRef(db, { path: ctmPath('a.ctm'), priority: 1, enabled: false });
    expect(attachTms(db, listTmRefs(db))).toHaveLength(0);
    db.close();
  });

  it('is idempotent — calling twice does not throw "already in use"', () => {
    const db = openProjectDb(dbPath());
    createTm(ctmPath('a.ctm'), { name: 'A', generator: 'test' }).close();
    const ref = addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });
    attachTms(db, listTmRefs(db));
    expect(() => attachTms(db, listTmRefs(db))).not.toThrow();
    // Still queryable — a re-attach attempt did not detach it either.
    expect(db.prepare(`SELECT 1 FROM ${tmAlias(ref.id)}.tm`).get()).toBeDefined();
    db.close();
  });

  it('detaches what it attached, and only that', () => {
    const db = openProjectDb(dbPath());
    createTm(ctmPath('a.ctm'), { name: 'A', generator: 'test' }).close();
    const ref = addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });
    const refs = listTmRefs(db);
    attachTms(db, refs);
    detachTms(db, refs);
    expect(() => db.prepare(`SELECT 1 FROM ${tmAlias(ref.id)}.tm`).get()).toThrow();
    // Detaching again is a no-op, not an error.
    expect(() => detachTms(db, refs)).not.toThrow();
    db.close();
  });
});
