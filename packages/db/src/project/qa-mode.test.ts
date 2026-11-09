import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor, type Segment } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import { countBlockingQa } from '../vendor/review.js';
import { editSegmentTarget } from './edit-target.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { addQaIssue, listQaIssues, sweepQa } from './qa-issues.js';
import {
  assertQaCurrent,
  clearQaUnswept,
  isQaDeferred,
  isQaStale,
  noteQaDeferredEdit,
  QaStaleError,
  setQaDeferred,
} from './qa-mode.js';
import { listSegments } from './segments.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'cat-qa-mode-'));
  dirs.push(dir);
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  insertFile(
    db,
    'a',
    assembleFile(
      new Uint8Array(readFileSync(join(FIXTURES, 'form-minimal.docx'))),
      rulesFor('en'),
    ),
    { actor: TEST_ACTOR },
  );
  return db;
}

const unlocked = (db: Database.Database): Segment[] =>
  listSegments(db, 1).filter((s) => !s.locked);
/** The target a translator copies from the source: QA flags it `seg.untranslated`. */
const copySource = (db: Database.Database, segment: Segment) =>
  editSegmentTarget(db, segment.id, {
    tokens: segment.sourceTokens.map((t) => ({
      t: 'text',
      v: t.t === 'text' ? t.v : '',
    })),
    actor: TEST_ACTOR,
  });
/** A project's findings with the volatile columns dropped, so two projects compare. */
const findings = (db: Database.Database) =>
  listQaIssues(db).map(({ segmentId, rule, severity, message, dismissed }) => ({
    segmentId,
    rule,
    severity,
    message,
    dismissed,
  }));

describe('the mode', () => {
  it('is live by default, with no row written', () => {
    const db = project();
    expect(isQaDeferred(db)).toBe(false);
    expect(isQaStale(db)).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM qa_mode_setting').get()).toEqual({
      n: 0,
    });
  });

  it('switches to deferred and back, logging each change once', () => {
    const db = project();
    expect(setQaDeferred(db, true, TEST_ACTOR)).toBe(true);
    expect(setQaDeferred(db, true, TEST_ACTOR)).toBe(true); // already so: no second event
    expect(isQaDeferred(db)).toBe(true);
    expect(setQaDeferred(db, false, TEST_ACTOR)).toBe(false);
    expect(isQaDeferred(db)).toBe(false);
    const changes = listEvents(db, { subjectType: 'project' }).filter(
      (e) => e.action === 'project.setting_changed',
    );
    expect(changes.map((e) => JSON.parse(e.detail ?? 'null'))).toEqual([
      { key: 'qa_mode', from: 'live', to: 'deferred' },
      { key: 'qa_mode', from: 'deferred', to: 'live' },
    ]);
  });

  it('refuses to go live while findings are stale, so live QA never trusts an unswept row', () => {
    const db = project();
    setQaDeferred(db, true, TEST_ACTOR);
    noteQaDeferredEdit(db);
    expect(() => setQaDeferred(db, false, TEST_ACTOR)).toThrow(QaStaleError);
    expect(isQaDeferred(db)).toBe(true);
    sweepQa(db);
    expect(setQaDeferred(db, false, TEST_ACTOR)).toBe(false);
  });
});

describe('an edit in a deferred project', () => {
  it('reruns no QA, counts itself, and leaves the stored findings as they were', () => {
    const db = project();
    setQaDeferred(db, true, TEST_ACTOR);
    const [first] = unlocked(db);
    const result = copySource(db, first!);
    expect(result.rerun).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(listQaIssues(db)).toEqual([]);
    expect(isQaStale(db)).toBe(true);
    expect(() => assertQaCurrent(db)).toThrow(QaStaleError);
  });

  it('in a live project reruns QA at once and never reads as stale', () => {
    const db = project();
    const [first] = unlocked(db);
    const result = copySource(db, first!);
    expect(result.rerun).toContain(first!.id);
    expect(listQaIssues(db).map((i) => i.rule)).toEqual(['seg.untranslated']);
    noteQaDeferredEdit(db); // a live project has no row to count on
    expect(isQaStale(db)).toBe(false);
    expect(() => assertQaCurrent(db)).not.toThrow();
  });
});

describe('sweepQa', () => {
  it('ends with the findings a live project would hold after the same edits', () => {
    const live = project();
    const deferred = project();
    setQaDeferred(deferred, true, TEST_ACTOR);
    for (const db of [live, deferred]) {
      for (const segment of unlocked(db).slice(0, 4)) copySource(db, segment);
    }
    expect(findings(deferred)).toEqual([]);
    const result = sweepQa(deferred);
    expect(result).toEqual({ segments: listSegments(deferred, 1).length, current: true });
    expect(findings(deferred)).toEqual(findings(live));
    expect(findings(deferred).length).toBeGreaterThan(0);
    expect(isQaStale(deferred)).toBe(false);
  });

  it('keeps a dismissal across the sweep', () => {
    const db = project();
    setQaDeferred(db, true, TEST_ACTOR);
    const [first] = unlocked(db);
    copySource(db, first!);
    sweepQa(db);
    db.prepare('UPDATE qa_issue SET dismissed = 1').run();
    copySource(db, { ...first!, sourceTokens: first!.sourceTokens });
    sweepQa(db);
    expect(listQaIssues(db).every((i) => i.dismissed)).toBe(true);
  });

  it('reports progress by batch, ending at the total', () => {
    const db = project();
    setQaDeferred(db, true, TEST_ACTOR);
    const seen: [number, number][] = [];
    sweepQa(db, (done, total) => seen.push([done, total]));
    const total = listSegments(db, 1).length;
    expect(seen.at(-1)).toEqual([total, total]);
  });

  it('clears only the edits it saw: one that lands during the sweep leaves the project stale', () => {
    const db = project();
    setQaDeferred(db, true, TEST_ACTOR);
    noteQaDeferredEdit(db);
    noteQaDeferredEdit(db);
    // What a sweep does at its end, with an edit counted after it read two.
    noteQaDeferredEdit(db);
    clearQaUnswept(db, 2);
    expect(isQaStale(db)).toBe(true);
    clearQaUnswept(db, 1);
    expect(isQaStale(db)).toBe(false);
  });

  it('says it is not current when an edit lands while it runs', () => {
    const db = project();
    setQaDeferred(db, true, TEST_ACTOR);
    const [first] = unlocked(db);
    let edited = false;
    const result = sweepQa(db, () => {
      if (!edited) {
        edited = true;
        copySource(db, first!);
      }
    });
    expect(result.current).toBe(false);
    expect(isQaStale(db)).toBe(true);
    expect(sweepQa(db).current).toBe(true);
  });
});

describe('the gate that reads QA (review)', () => {
  const planted = (db: Database.Database) =>
    addQaIssue(db, {
      segmentId: unlocked(db)[0]!.id,
      rule: 'tag.missing',
      severity: 'error',
      message: 'a blocking finding',
    });

  it('counts blocking findings as it always did in a live project', () => {
    const db = project();
    planted(db);
    expect(countBlockingQa(db)).toBe(1);
  });

  it('refuses stale findings rather than count them, and counts them after a sweep', () => {
    const db = project();
    setQaDeferred(db, true, TEST_ACTOR);
    noteQaDeferredEdit(db);
    expect(() => countBlockingQa(db)).toThrow(QaStaleError);
    sweepQa(db);
    expect(countBlockingQa(db)).toBe(0);
  });
});
