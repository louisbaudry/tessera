import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { createTm } from '../tm/index.js';
import { openProjectDb } from './index.js';
import {
  addTmRef,
  attachTms,
  detachTms,
  listTmRefs,
  nextTmPriority,
  removeTmRef,
  reorderTmRefs,
  setWriteTarget,
  tmAlias,
  TM_REFS_SETTING,
  TmRefError,
} from './tm-refs.js';

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
    addTmRef(db, { actor: TEST_ACTOR, path: 'c.ctm', priority: 3 });
    addTmRef(db, { actor: TEST_ACTOR, path: 'a.ctm', priority: 1 });
    addTmRef(db, { actor: TEST_ACTOR, path: 'b.ctm', priority: 2 });
    expect(listTmRefs(db).map((r) => r.path)).toEqual(['a.ctm', 'b.ctm', 'c.ctm']);
    db.close();
  });

  it('defaults isWriteTarget/enabled sensibly', () => {
    const db = openProjectDb(dbPath());
    const ref = addTmRef(db, { actor: TEST_ACTOR, path: 'a.ctm', priority: 1 });
    expect(ref.isWriteTarget).toBe(false);
    expect(ref.enabled).toBe(true);
    db.close();
  });
});

describe('setWriteTarget', () => {
  it('moves the write target atomically, never leaving zero or two', () => {
    const db = openProjectDb(dbPath());
    const a = addTmRef(db, {
      actor: TEST_ACTOR,
      path: 'a.ctm',
      priority: 1,
      isWriteTarget: true,
    });
    const b = addTmRef(db, { actor: TEST_ACTOR, path: 'b.ctm', priority: 2 });

    setWriteTarget(db, b.id, { actor: TEST_ACTOR });
    const refs = listTmRefs(db);
    expect(refs.find((r) => r.id === a.id)!.isWriteTarget).toBe(false);
    expect(refs.find((r) => r.id === b.id)!.isWriteTarget).toBe(true);
    db.close();
  });

  it('refuses an unknown id', () => {
    const db = openProjectDb(dbPath());
    expect(() => setWriteTarget(db, 999_999, { actor: TEST_ACTOR })).toThrow(TmRefError);
    db.close();
  });
});

describe('addTmRef as write target', () => {
  it('takes the write target from the previous one, in one change', () => {
    const db = openProjectDb(dbPath());
    const a = addTmRef(db, {
      actor: TEST_ACTOR,
      path: 'a.ctm',
      priority: 1,
      isWriteTarget: true,
    });
    const b = addTmRef(db, {
      actor: TEST_ACTOR,
      path: 'b.ctm',
      priority: 2,
      isWriteTarget: true,
    });
    const refs = listTmRefs(db);
    expect(refs.find((r) => r.id === a.id)!.isWriteTarget).toBe(false);
    expect(refs.find((r) => r.id === b.id)!.isWriteTarget).toBe(true);
    db.close();
  });
});

describe('nextTmPriority', () => {
  it('is 1 for none, then one after the highest', () => {
    const db = openProjectDb(dbPath());
    expect(nextTmPriority(db)).toBe(1);
    addTmRef(db, { actor: TEST_ACTOR, path: 'a.ctm', priority: 4 });
    expect(nextTmPriority(db)).toBe(5);
    db.close();
  });
});

describe('removeTmRef', () => {
  it('detaches one reference, leaving the rest and no write target if it was one', () => {
    const db = openProjectDb(dbPath());
    const a = addTmRef(db, {
      actor: TEST_ACTOR,
      path: 'a.ctm',
      priority: 1,
      isWriteTarget: true,
    });
    addTmRef(db, { actor: TEST_ACTOR, path: 'b.ctm', priority: 2 });
    removeTmRef(db, a.id, { actor: TEST_ACTOR });
    expect(listTmRefs(db).map((r) => [r.path, r.isWriteTarget])).toEqual([
      ['b.ctm', false],
    ]);
    db.close();
  });

  it('refuses an unknown id and logs nothing', () => {
    const db = openProjectDb(dbPath());
    expect(() => removeTmRef(db, 7, { actor: TEST_ACTOR })).toThrow(TmRefError);
    expect(listEvents(db, { subjectType: 'project' })).toEqual([]);
    db.close();
  });
});

describe('reorderTmRefs', () => {
  it('renumbers priorities 1…n in the order given', () => {
    const db = openProjectDb(dbPath());
    const a = addTmRef(db, { actor: TEST_ACTOR, path: 'a.ctm', priority: 1 });
    const b = addTmRef(db, { actor: TEST_ACTOR, path: 'b.ctm', priority: 5 });
    const c = addTmRef(db, { actor: TEST_ACTOR, path: 'c.ctm', priority: 9 });
    const refs = reorderTmRefs(db, [c.id, a.id, b.id], { actor: TEST_ACTOR });
    expect(refs.map((r) => [r.path, r.priority])).toEqual([
      ['c.ctm', 1],
      ['a.ctm', 2],
      ['b.ctm', 3],
    ]);
    db.close();
  });

  it.each([
    ['one missing', (a: number) => [a]],
    ['one twice', (a: number, b: number) => [a, b, b]],
    ['an unknown id', (a: number) => [a, 99]],
  ])('refuses an order with %s, changing nothing', (_, order) => {
    const db = openProjectDb(dbPath());
    const a = addTmRef(db, { actor: TEST_ACTOR, path: 'a.ctm', priority: 1 });
    const b = addTmRef(db, { actor: TEST_ACTOR, path: 'b.ctm', priority: 2 });
    expect(() => reorderTmRefs(db, order(a.id, b.id), { actor: TEST_ACTOR })).toThrow(
      TmRefError,
    );
    expect(listTmRefs(db).map((r) => r.priority)).toEqual([1, 2]);
    db.close();
  });
});

describe('the log of the list', () => {
  it('records every change as the whole list before and after, chain intact', () => {
    const db = openProjectDb(dbPath());
    const a = addTmRef(db, { actor: TEST_ACTOR, path: 'a.ctm', priority: 1 });
    const b = addTmRef(db, { actor: TEST_ACTOR, path: 'b.ctm', priority: 2 });
    setWriteTarget(db, b.id, { actor: TEST_ACTOR });
    reorderTmRefs(db, [b.id, a.id], { actor: TEST_ACTOR });
    removeTmRef(db, a.id, { actor: TEST_ACTOR });

    const events = listEvents(db, { subjectType: 'project' });
    expect(events.map((e) => e.action)).toEqual(Array(5).fill('project.setting_changed'));
    expect(events.every((e) => e.actor === 'cli:test')).toBe(true);
    const detail = events.map(
      (e) => JSON.parse(e.detail!) as { key: string; from: unknown; to: unknown },
    );
    expect(detail.every((d) => d.key === TM_REFS_SETTING)).toBe(true);
    // Each event starts where the one before it ended.
    for (let i = 1; i < detail.length; i++) {
      expect(detail[i]!.from).toEqual(detail[i - 1]!.to);
    }
    expect(detail[0]!.from).toEqual([]);
    expect(detail[3]!.to).toEqual([
      { id: b.id, path: 'b.ctm', priority: 1, write_target: true, enabled: true },
      { id: a.id, path: 'a.ctm', priority: 2, write_target: false, enabled: true },
    ]);
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });
});

describe('attachTms / detachTms', () => {
  it('attaches every enabled TM under a stable alias, reachable by query', () => {
    const db = openProjectDb(dbPath());
    createTm(ctmPath('a.ctm'), { name: 'A', generator: 'test' }).close();
    createTm(ctmPath('b.ctm'), { name: 'B', generator: 'test' }).close();
    const a = addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });
    const b = addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('b.ctm'), priority: 2 });

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
    addTmRef(db, {
      actor: TEST_ACTOR,
      path: ctmPath('a.ctm'),
      priority: 1,
      enabled: false,
    });
    expect(attachTms(db, listTmRefs(db))).toHaveLength(0);
    db.close();
  });

  it('is idempotent — calling twice does not throw "already in use"', () => {
    const db = openProjectDb(dbPath());
    createTm(ctmPath('a.ctm'), { name: 'A', generator: 'test' }).close();
    const ref = addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });
    attachTms(db, listTmRefs(db));
    expect(() => attachTms(db, listTmRefs(db))).not.toThrow();
    // Still queryable — a re-attach attempt did not detach it either.
    expect(db.prepare(`SELECT 1 FROM ${tmAlias(ref.id)}.tm`).get()).toBeDefined();
    db.close();
  });

  it('detaches what it attached, and only that', () => {
    const db = openProjectDb(dbPath());
    createTm(ctmPath('a.ctm'), { name: 'A', generator: 'test' }).close();
    const ref = addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });
    const refs = listTmRefs(db);
    attachTms(db, refs);
    detachTms(db, refs);
    expect(() => db.prepare(`SELECT 1 FROM ${tmAlias(ref.id)}.tm`).get()).toThrow();
    // Detaching again is a no-op, not an error.
    expect(() => detachTms(db, refs)).not.toThrow();
    db.close();
  });
});
