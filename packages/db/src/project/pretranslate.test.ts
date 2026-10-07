import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  carryHiddenTags,
  fuzzyOrigin,
  plainText,
  rulesFor,
  withoutHiddenTags,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTm } from '../tm/index.js';
import { setFuzzyThreshold } from './fuzzy-settings.js';
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

/** A segment with a tag the translator places, not only hidden ones. */
function findVisiblyTaggedSegment(db: Database.Database, fileId: number) {
  const found = listSegments(db, fileId).find(
    (s) => !s.locked && s.formatTable.some((f) => f.visible),
  );
  if (!found) throw new Error('fixture has no segment with a visible tag');
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
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

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
      assembleFile(loadDocx('form-release.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findVisiblyTaggedSegment(db, file.id);

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
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary.tagdiff).toBe(1);
    expect(summary.exact).toBe(0);

    const after = getSegment(db, segment.id)!;
    expect(after.status).toBe('draft');
    expect(after.origin).toBe('tm_exact_tagdiff');
    // The text only, with the source's hidden tags carried around it.
    expect(withoutHiddenTags(after.targetTokens!, after.formatTable)).toEqual([
      { t: 'text', v: 'Sin etiquetas' },
    ]);

    const issues = listQaIssues(db, segment.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('tag.missing');
    expect(issues[0]!.severity).toBe('warning');
    db.close();
  });

  it('a mismatch in hidden tags only is an exact match, its hidden tags carried (backlog #29)', () => {
    // A memory that lacks this document's spell-check markers leaves the
    // translator nothing to reapply: no tagdiff, no warning.
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findTaggedSegment(db, file.id);
    expect(segment.formatTable.every((f) => !f.visible)).toBe(true);

    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: segment.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'Sin etiquetas' }],
    });
    tm.close();
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary).toMatchObject({ exact: 1, tagdiff: 0 });
    const after = getSegment(db, segment.id)!;
    expect(after).toMatchObject({ status: 'translated', origin: 'tm_exact' });
    expect(after.targetTokens).toEqual(
      carryHiddenTags(
        [{ t: 'text', v: 'Sin etiquetas' }],
        segment.sourceTokens,
        segment.formatTable,
      ),
    );
    expect(listQaIssues(db, segment.id)).toEqual([]);
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
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('low.ctm'), priority: 2 });
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('high.ctm'), priority: 1 });

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
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

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
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

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
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

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

/** A unit whose source is `srcPlain` — a different hash from any segment's, so only fuzzy can find it. */
function insertFuzzyUnit(
  tmDb: Database.Database,
  options: { srcPlain: string; tgtText: string; srcLang?: string; tgtLang?: string },
): void {
  const now = new Date().toISOString();
  const tuId = tmDb
    .prepare('INSERT INTO tu (uuid, created_at, updated_at) VALUES (?, ?, ?)')
    .run(randomUUID(), now, now).lastInsertRowid as number;
  const add = (lang: string, text: string, quality: number) =>
    tmDb
      .prepare(
        `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, quality, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tuId,
        lang,
        JSON.stringify([{ t: 'text', v: text }]),
        text,
        `hash:${lang}:${text}`,
        quality,
        now,
        now,
      );
  add(options.srcLang ?? 'en', options.srcPlain, 2);
  add(options.tgtLang ?? 'es', options.tgtText, 2);
}

/** `text` with its last word replaced: one word of `n` differs, a score of floor(100 * (n - 1) / n). */
function withLastWordChanged(text: string): { changed: string; score: number } {
  const words = text.split(' ');
  words[words.length - 1] = 'zzqx';
  return {
    changed: words.join(' '),
    score: Math.floor((100 * (words.length - 1)) / words.length),
  };
}

describe('pretranslate: fuzzy matches (v1-spec.md §6.1a)', () => {
  /** A project with one plain segment of at least eight words, and that segment's text. */
  function setup() {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    // Only hidden tags (or none), and plain words: the score is then the
    // arithmetic in `withLastWordChanged`, with no tag or numeral term.
    const wordsOnly = (text: string) =>
      text.split(' ').every((w) => /^\p{L}+[.,;:!?]?$/u.test(w));
    const segment = listSegments(db, file.id).find((s) => {
      const text = plainText(s.sourceTokens).trim();
      return (
        !s.locked &&
        s.formatTable.every((f) => !f.visible) &&
        text.split(' ').length >= 8 &&
        wordsOnly(text)
      );
    });
    if (!segment) throw new Error('fixture has no plain segment of eight words');
    return { db, segment, text: plainText(segment.sourceTokens).trim() };
  }

  it('places a close match as a draft, with its score as the origin', () => {
    const { db, segment, text } = setup();
    const { changed, score } = withLastWordChanged(text);
    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertFuzzyUnit(tm, { srcPlain: changed, tgtText: 'Texto cercano' });
    tm.close();
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR });
    expect(summary.fuzzy).toBe(1);
    expect(summary.exact).toBe(0);

    const after = getSegment(db, segment.id)!;
    expect(after.origin).toBe(fuzzyOrigin(score));
    expect(after.status).toBe('draft');
    expect(withoutHiddenTags(after.targetTokens!, after.formatTable)).toEqual([
      { t: 'text', v: 'Texto cercano' },
    ]);
    db.close();
  });

  it('never writes a match under the threshold, however close the next one is', () => {
    const { db, segment, text } = setup();
    const { changed, score } = withLastWordChanged(text);
    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertFuzzyUnit(tm, { srcPlain: changed, tgtText: 'Texto cercano' });
    tm.close();
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

    const summary = pretranslate(db, { actor: TEST_ACTOR, fuzzyThreshold: score + 1 });
    expect(summary.fuzzy).toBe(0);
    expect(getSegment(db, segment.id)!.targetTokens).toBeNull();
    db.close();
  });

  it('is off with a null threshold', () => {
    const { db, segment, text } = setup();
    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertFuzzyUnit(tm, { srcPlain: withLastWordChanged(text).changed, tgtText: 'x' });
    tm.close();
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

    expect(pretranslate(db, { actor: TEST_ACTOR, fuzzyThreshold: null }).fuzzy).toBe(0);
    expect(getSegment(db, segment.id)!.targetTokens).toBeNull();
    db.close();
  });

  it("uses the project's own threshold when the run gives none, and the run's wins", () => {
    const { db, segment, text } = setup();
    const { changed, score } = withLastWordChanged(text);
    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertFuzzyUnit(tm, { srcPlain: changed, tgtText: 'Texto cercano' });
    tm.close();
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

    // A setting above the match's score: nothing is placed.
    setFuzzyThreshold(db, score + 1, TEST_ACTOR);
    expect(pretranslate(db, { actor: TEST_ACTOR }).fuzzy).toBe(0);
    expect(getSegment(db, segment.id)!.targetTokens).toBeNull();

    // The run's own option wins over it, for that run.
    expect(pretranslate(db, { actor: TEST_ACTOR, fuzzyThreshold: score }).fuzzy).toBe(1);
    db.close();
  });

  it('is off when the project says off, and the run records the threshold it used', () => {
    const { db, segment, text } = setup();
    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertFuzzyUnit(tm, { srcPlain: withLastWordChanged(text).changed, tgtText: 'x' });
    tm.close();
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });
    setFuzzyThreshold(db, null, TEST_ACTOR);

    expect(pretranslate(db, { actor: TEST_ACTOR }).fuzzy).toBe(0);
    expect(getSegment(db, segment.id)!.targetTokens).toBeNull();
    const run = db
      .prepare("SELECT detail FROM audit_event WHERE action = 'project.pretranslate'")
      .get() as { detail: string };
    expect(JSON.parse(run.detail).fuzzy_threshold).toBeNull();
    db.close();
  });

  it('refuses a threshold outside 50-99', () => {
    const { db } = setup();
    for (const bad of [49, 100, 75.5]) {
      expect(() => pretranslate(db, { actor: TEST_ACTOR, fuzzyThreshold: bad })).toThrow(
        PretranslateError,
      );
    }
    db.close();
  });

  it('prefers the closer match across memories, and priority only on a tie', () => {
    const { db, segment, text } = setup();
    const near = withLastWordChanged(text).changed;
    // Two words differ in the second memory's unit: a lower score.
    const words = near.split(' ');
    words[0] = 'zzqy';
    const farther = words.join(' ');

    for (const [name, srcPlain, tgtText, priority] of [
      ['a.ctm', farther, 'del primero', 1],
      ['b.ctm', near, 'del segundo', 2],
      ['c.ctm', near, 'del tercero', 3],
    ] as const) {
      const tm = createTm(ctmPath(name), { name, generator: 'test' });
      insertFuzzyUnit(tm, { srcPlain, tgtText });
      tm.close();
      addTmRef(db, { actor: TEST_ACTOR, path: ctmPath(name), priority });
    }

    pretranslate(db, { actor: TEST_ACTOR, fuzzyThreshold: 50 });
    // b beats a on score; c ties b and loses on priority.
    expect(
      withoutHiddenTags(getSegment(db, segment.id)!.targetTokens!, segment.formatTable),
    ).toEqual([{ t: 'text', v: 'del segundo' }]);
    db.close();
  });

  it('leaves an exact match to the exact path, and a confirmed segment alone', () => {
    const { db, segment, text } = setup();
    const tm = createTm(ctmPath('a.ctm'), { name: 'a', generator: 'test' });
    insertTmUnit(tm, {
      srcLang: 'en',
      srcHash: segment.sourceHash,
      tgtLang: 'es',
      targetTokens: [{ t: 'text', v: 'Exacto' }],
    });
    insertFuzzyUnit(tm, {
      srcPlain: withLastWordChanged(text).changed,
      tgtText: 'Cercano',
    });
    tm.close();
    addTmRef(db, { actor: TEST_ACTOR, path: ctmPath('a.ctm'), priority: 1 });

    pretranslate(db, { actor: TEST_ACTOR });
    expect(getSegment(db, segment.id)!.origin).toBe('tm_exact');
    db.close();
  });
});
