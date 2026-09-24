import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTm } from '../tm/index.js';
import { createProject } from './project.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { listQaIssues } from './qa-issues.js';
import { pretranslate, PretranslateError } from './pretranslate.js';
import { getSegment, listSegments, setSegmentTarget } from './segments.js';
import { addTmRef } from './tm-refs.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const loadDocx = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-pretranslate-'));
  return join(dir, 'project.catdb');
};
const ctmPath = (name: string) => join(dir, name);

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A segment with no tags at all — the trivial "multiset equal" case. */
function findPlainSegment(db: Database.Database, fileId: number) {
  const found = listSegments(db, fileId).find(
    (s) => !s.locked && s.sourceTokens.every((t) => t.t === 'text'),
  );
  if (!found) throw new Error('fixture has no eligible plain-text-only segment');
  return found;
}

/** A segment with at least one tag — for the tag-multiset-differs case. */
function findTaggedSegment(db: Database.Database, fileId: number) {
  const found = listSegments(db, fileId).find(
    (s) => !s.locked && s.formatTable.length > 0,
  );
  if (!found) throw new Error('fixture has no eligible tagged segment');
  return found;
}

/**
 * Inserts one TU with one source and one target variant directly, keyed
 * on a real segment's own `sourceHash` — this module cares only about
 * `retrievePair`'s join on `hash`, not `normalizeTokens`'s own
 * correctness (covered elsewhere), so the hash is supplied rather than
 * derived.
 */
function insertTmUnit(
  tmDb: Database.Database,
  options: {
    srcLang: string;
    srcHash: string;
    tgtLang: string;
    targetTokens: unknown;
    quality?: number;
    updatedAt?: string;
  },
): void {
  const now = options.updatedAt ?? new Date().toISOString();
  const tu = tmDb
    .prepare('INSERT INTO tu (uuid, created_at, updated_at) VALUES (?, ?, ?)')
    .run(randomUUID(), now, now);
  const tuId = tu.lastInsertRowid as number;
  tmDb
    .prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tuId,
      options.srcLang,
      JSON.stringify([{ t: 'text', v: 'source placeholder' }]),
      'source placeholder',
      options.srcHash,
      now,
      now,
    );
  tmDb
    .prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, quality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tuId,
      options.tgtLang,
      JSON.stringify(options.targetTokens),
      'target placeholder',
      `target-hash-${tuId}`,
      options.quality ?? 2,
      now,
      now,
    );
}

describe('pretranslate', () => {
  it('throws when the project has no identity row', () => {
    const db = openProjectDb(dbPath());
    expect(() => pretranslate(db, { actor: TEST_ACTOR })).toThrow(PretranslateError);
    db.close();
  });

  it('exact TM match: tag multiset trivially equal (plain text) — tm_exact, translated', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findPlainSegment(db, file.id);

    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: segment.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'Texto traducido' }],
    });
    tm.close();
    addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary.exact).toBe(1);
    expect(summary.tagdiff).toBe(0);

    const after = getSegment(db, segment.id)!;
    expect(after.status).toBe('translated');
    expect(after.origin).toBe('tm_exact');
    expect(after.targetTokens).toEqual([{ t: 'text', v: 'Texto traducido' }]);
    expect(listQaIssues(db, segment.id)).toHaveLength(0);
    db.close();
  });

  it('tag multiset differs: falls back to text-only, tm_exact_tagdiff, draft, and a QA warning', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findTaggedSegment(db, file.id);

    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    // No tags at all in the match — guaranteed multiset mismatch against
    // a source that has at least one tag kind.
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: segment.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'Sin etiquetas' }],
    });
    tm.close();
    addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary.tagdiff).toBe(1);
    expect(summary.exact).toBe(0);

    const after = getSegment(db, segment.id)!;
    expect(after.status).toBe('draft');
    expect(after.origin).toBe('tm_exact_tagdiff');
    expect(after.targetTokens).toEqual([{ t: 'text', v: 'Sin etiquetas' }]);

    const issues = listQaIssues(db, segment.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('tag.missing');
    expect(issues[0]!.severity).toBe('warning');
    db.close();
  });

  it('priority order: the first attached TM with a hit wins, even if a lower-priority one also matches', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findPlainSegment(db, file.id);

    const tmHigh = createTm(ctmPath('high.ctm'), { name: 'high', generator: 'test' });
    insertTmUnit(tmHigh, {
      srcLang: 'en',
      srcHash: segment.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'De la memoria prioritaria' }],
    });
    tmHigh.close();

    const tmLow = createTm(ctmPath('low.ctm'), { name: 'low', generator: 'test' });
    insertTmUnit(tmLow, {
      srcLang: 'en',
      srcHash: segment.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'De la memoria secundaria' }],
    });
    tmLow.close();

    // Registered out of priority order — listTmRefs/attachTms sort by
    // priority regardless of insertion order.
    addTmRef(db, { path: ctmPath('low.ctm'), priority: 2 });
    addTmRef(db, { path: ctmPath('high.ctm'), priority: 1 });

    pretranslate(db, { actor: TEST_ACTOR });
    const after = getSegment(db, segment.id)!;
    expect(after.targetTokens).toEqual([{ t: 'text', v: 'De la memoria prioritaria' }]);
    db.close();
  });

  it('internal propagation: no TM, but a confirmed sibling segment shares the source hash', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const assembled = assembleFile(loadDocx('form-minimal.docx'), rulesFor('en'));
    const fileA = insertFile(db, 'a.docx', assembled, { actor: TEST_ACTOR });
    const fileB = insertFile(db, 'b.docx', assembled, { actor: TEST_ACTOR }); // identical content -> identical source hashes

    const segmentA = findPlainSegment(db, fileA.id);
    const segmentB = listSegments(db, fileB.id).find((s) => s.ord === segmentA.ord)!;
    expect(segmentB.sourceHash).toBe(segmentA.sourceHash);

    setSegmentTarget(db, segmentA.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Ya confirmado' }],
      status: 'confirmed',
      origin: 'tm_exact',
    });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary.propagated).toBe(1);

    const after = getSegment(db, segmentB.id)!;
    expect(after.status).toBe('draft');
    expect(after.origin).toBe('propagated');
    expect(after.targetTokens).toEqual([{ t: 'text', v: 'Ya confirmado' }]);
    db.close();
  });

  it('a TM hit takes priority over internal propagation for the same segment', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const assembled = assembleFile(loadDocx('form-minimal.docx'), rulesFor('en'));
    const fileA = insertFile(db, 'a.docx', assembled, { actor: TEST_ACTOR });
    const fileB = insertFile(db, 'b.docx', assembled, { actor: TEST_ACTOR });
    const segmentA = findPlainSegment(db, fileA.id);
    const segmentB = listSegments(db, fileB.id).find((s) => s.ord === segmentA.ord)!;

    setSegmentTarget(db, segmentA.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Confirmado internamente' }],
      status: 'confirmed',
      origin: 'tm_exact',
    });

    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: segmentB.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'De la memoria' }],
    });
    tm.close();
    addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary.exact).toBe(1);
    expect(summary.propagated).toBe(0);
    expect(getSegment(db, segmentB.id)!.targetTokens).toEqual([
      { t: 'text', v: 'De la memoria' },
    ]);
    db.close();
  });

  it('never touches a confirmed or locked segment', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const locked = listSegments(db, file.id).find((s) => s.locked)!;
    expect(locked).toBeDefined();
    const plain = findPlainSegment(db, file.id);
    setSegmentTarget(db, plain.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Confirmed by hand' }],
      status: 'confirmed',
      origin: null,
    });

    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: locked.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'Would overwrite the lock' }],
    });
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: plain.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'Would overwrite the confirmation' }],
    });
    tm.close();
    addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary.skipped).toBeGreaterThanOrEqual(2); // at least the locked + the confirmed segment
    expect(getSegment(db, locked.id)!.targetTokens).toBeNull();
    expect(getSegment(db, plain.id)!.targetTokens).toEqual([
      { t: 'text', v: 'Confirmed by hand' },
    ]);
    db.close();
  });

  it('leaves an eligible segment untouched when nothing matches', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findPlainSegment(db, file.id);

    const summary = pretranslate(db, { actor: TEST_ACTOR }); // no TMs attached, nothing confirmed yet
    expect(summary.unmatched).toBeGreaterThan(0);
    expect(getSegment(db, segment.id)!.status).toBe('new');
    db.close();
  });

  it('is idempotent: a second run reproduces the same state', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findPlainSegment(db, file.id);

    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: segment.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'Texto traducido' }],
    });
    tm.close();
    addTmRef(db, { path: ctmPath('a.ctm'), priority: 1 });

    pretranslate(db, { actor: TEST_ACTOR });
    const firstRun = getSegment(db, segment.id)!;
    const summary2 = pretranslate(db, { actor: TEST_ACTOR });
    const secondRun = getSegment(db, segment.id)!;

    expect(secondRun.targetTokens).toEqual(firstRun.targetTokens);
    expect(secondRun.status).toBe(firstRun.status);
    expect(secondRun.origin).toBe(firstRun.origin);
    expect(summary2.exact).toBe(1);
    db.close();
  });

  it('scopes candidates to one file with fileId, but propagation donors still span the whole project', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const assembled = assembleFile(loadDocx('form-minimal.docx'), rulesFor('en'));
    const fileA = insertFile(db, 'a.docx', assembled, { actor: TEST_ACTOR });
    const fileB = insertFile(db, 'b.docx', assembled, { actor: TEST_ACTOR });
    const segmentA = findPlainSegment(db, fileA.id);
    const segmentB = listSegments(db, fileB.id).find((s) => s.ord === segmentA.ord)!;

    setSegmentTarget(db, segmentA.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Confirmado' }],
      status: 'confirmed',
      origin: 'tm_exact',
    });

    const summary = pretranslate(db, { actor: TEST_ACTOR, fileId: fileB.id });
    expect(summary.propagated).toBe(1);
    expect(getSegment(db, segmentB.id)!.origin).toBe('propagated');
    db.close();
  });
});
