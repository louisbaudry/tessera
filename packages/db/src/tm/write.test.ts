import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashOf } from '@cat-tool/core';
import type { TmToken } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { capturePlans, scansOf } from '../query-plan.fixture.js';

import { createTm } from './index.js';
import { retrievePair } from './retrieve.js';
import { refreshLangs, writeBack, WriteBackError } from './write.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-tm-write-'));
  return join(dir, 'memory.ctm');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const text = (v: string): TmToken[] => [{ t: 'text', v }];

describe('writeBack', () => {
  it('creates a fresh tu with quality 2 (confirmed) when the source has never been seen', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const result = writeBack(db, {
      source: { lang: 'en', tokens: text('Hello') },
      target: { lang: 'es', tokens: text('Hola') },
    });
    expect(result.tuCreated).toBe(true);
    expect(result.source.created).toBe(true);
    expect(result.target.created).toBe(true);
    expect(result.source.rev).toBe(1);
    expect(result.target.rev).toBe(1);

    const row = db
      .prepare('SELECT lang, tokens, quality FROM tuv ORDER BY lang')
      .all() as Array<{
      lang: string;
      tokens: string;
      quality: number;
    }>;
    expect(row).toHaveLength(2);
    expect(row[0]).toMatchObject({ lang: 'en', quality: 2 });
    expect(row[1]).toMatchObject({ lang: 'es', quality: 2 });
    expect(JSON.parse(row[1]!.tokens)).toEqual(text('Hola'));
    db.close();
  });

  it('is retrievable via retrievePair immediately after', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Hello') },
      target: { lang: 'es', tokens: text('Hola') },
    });
    const matches = retrievePair(db, {
      srcLang: 'en',
      srcHash: hashOf('Hello'),
      tgtLang: 'es',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tokens).toEqual(text('Hola'));
    db.close();
  });

  it('reuses the same tu when the source has already been seen — the multilingual model, not flattened to a pair', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const first = writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    const second = writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'de', tokens: text('Speichern') },
    });
    expect(second.tuId).toBe(first.tuId);
    expect(second.tuCreated).toBe(false);
    // The existing English source variant is untouched, not duplicated.
    expect(second.source.created).toBe(false);
    const enRows = db.prepare("SELECT COUNT(*) AS n FROM tuv WHERE lang = 'en'").get();
    expect(enRows).toEqual({ n: 1 });
    const langs = db.prepare('SELECT langs FROM tm').get() as { langs: string };
    expect(JSON.parse(langs.langs)).toEqual(['de', 'en', 'es']);
    db.close();
  });

  it('re-confirming the same target text with the same tag shape updates in place, no history row', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    const second = writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar ahora') },
    });
    expect(second.target.created).toBe(false);
    expect(second.target.historized).toBe(false);
    expect(second.target.rev).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv_history').get()).toEqual({ n: 0 });
    const tuv = db.prepare("SELECT tokens FROM tuv WHERE lang = 'es'").get() as {
      tokens: string;
    };
    expect(JSON.parse(tuv.tokens)).toEqual(text('Guardar ahora'));
    db.close();
  });

  it('preserves the old value in tuv_history when the tag kind multiset changes, before overwriting', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const bold: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'Guardar' },
      { t: 'close', id: 1 },
    ];
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: bold },
    });
    const second = writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') }, // no tags at all now
    });
    expect(second.target.historized).toBe(true);
    const history = db.prepare('SELECT rev, tokens FROM tuv_history').all() as Array<{
      rev: number;
      tokens: string;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.rev).toBe(1);
    expect(JSON.parse(history[0]!.tokens)).toEqual(bold);
    db.close();
  });

  it('never lowers an existing quality — re-confirming something already reviewed leaves it reviewed', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    db.prepare("UPDATE tuv SET quality = 3 WHERE lang = 'es'").run(); // reviewed by a second pair of eyes
    const second = writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar todo') },
    });
    const tuv = db.prepare("SELECT quality FROM tuv WHERE lang = 'es'").get() as {
      quality: number;
    };
    expect(tuv.quality).toBe(3);
    expect(second.target.rev).toBe(2);
    db.close();
  });

  it('stores prev_hash/next_hash when supplied, NULL when omitted', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: {
        lang: 'en',
        tokens: text('Save'),
        prevHash: 'hash-before',
        nextHash: 'hash-after',
      },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    const rows = db
      .prepare('SELECT lang, prev_hash, next_hash FROM tuv ORDER BY lang')
      .all();
    expect(rows).toEqual([
      { lang: 'en', prev_hash: 'hash-before', next_hash: 'hash-after' },
      { lang: 'es', prev_hash: null, next_hash: null },
    ]);
    db.close();
  });

  it('records updated_by/created_by from the supplied updatedBy', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save'), updatedBy: 'alice' },
      target: { lang: 'es', tokens: text('Guardar'), updatedBy: 'alice' },
    });
    const tuv = db.prepare("SELECT updated_by FROM tuv WHERE lang = 'es'").get();
    expect(tuv).toEqual({ updated_by: 'alice' });
    db.close();
  });

  it('refuses source and target in the same language, before writing anything', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    expect(() =>
      writeBack(db, {
        source: { lang: 'en', tokens: text('Save') },
        target: { lang: 'en', tokens: text('Save') },
      }),
    ).toThrow(WriteBackError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv').get()).toEqual({ n: 0 });
    db.close();
  });

  it('runs as a single transaction: a failure writing the target leaves the source and tu uncommitted too', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    // Fail the *second* `INSERT INTO tuv` (the target variant) — the tu
    // row and the source variant are already prepared by that point,
    // but must not survive the rollback.
    const realPrepare = db.prepare.bind(db);
    let tuvInserts = 0;
    db.prepare = ((sql: string) => {
      if (sql.includes('INSERT INTO tuv\n')) {
        tuvInserts++;
        if (tuvInserts === 2) throw new Error('simulated failure');
      }
      return realPrepare(sql);
    }) as typeof db.prepare;

    expect(() =>
      writeBack(db, {
        source: { lang: 'en', tokens: text('Save') },
        target: { lang: 'es', tokens: text('Guardar') },
      }),
    ).toThrow('simulated failure');
    db.prepare = realPrepare;
    expect(db.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('refreshLangs', () => {
  it('reflects every language actually present in tuv, sorted', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    refreshLangs(db);
    const langs = db.prepare('SELECT langs FROM tm').get() as { langs: string };
    expect(JSON.parse(langs.langs)).toEqual(['en', 'es']);
    db.close();
  });

  it('matches SELECT DISTINCT exactly: every tag, each once, in binary order', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    // Case and region variants are distinct stored tags, and binary
    // collation sorts uppercase first — the projection keeps both facts.
    for (const [src, tgt] of [
      ['en-US', 'fr'],
      ['en-US', 'de'],
      ['EN', 'fr-CA'],
      ['en', 'fr'],
    ] as const) {
      writeBack(db, {
        source: { lang: src, tokens: text(`Hello ${src}`) },
        target: { lang: tgt, tokens: text(`Bonjour ${tgt}`) },
      });
    }
    const distinct = (
      db.prepare('SELECT DISTINCT lang FROM tuv ORDER BY lang').all() as Array<{
        lang: string;
      }>
    ).map((r) => r.lang);
    const langs = db.prepare('SELECT langs FROM tm').get() as { langs: string };
    expect(JSON.parse(langs.langs)).toEqual(distinct);
    expect(distinct).toEqual(['EN', 'de', 'en', 'en-US', 'fr', 'fr-CA']);
    db.close();
  });

  it('writes an empty list for an empty memory', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    refreshLangs(db);
    const langs = db.prepare('SELECT langs FROM tm').get() as { langs: string };
    expect(JSON.parse(langs.langs)).toEqual([]);
    db.close();
  });

  // Backlog #20a: `SELECT DISTINCT lang FROM tuv` read every index entry
  // on every confirm — 247 ms at 1M units, and green at every test size.
  // Its plan was `SCAN tuv USING COVERING INDEX tuv_lookup`; the loose
  // index scan reads tuv only by `SEARCH`.
  it('reads tuv by seeks only, never a walk of the whole index', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    const plans = capturePlans(db, () => refreshLangs(db));
    const tuvReads = plans.flat().filter((d) => /^(SCAN|SEARCH) tuv\b/.test(d));
    expect(tuvReads.length).toBeGreaterThan(0);
    expect(scansOf(plans, ['tuv'])).toEqual([]);
    db.close();
  });
});

// WriteBackError is exported for callers that want to narrow the error type;
// nothing in this module currently throws it directly (a constraint
// violation surfaces as better-sqlite3's own error instead), so there is
// no dedicated test for it beyond confirming the export exists.
describe('WriteBackError', () => {
  it('is a real Error subclass', () => {
    const err = new WriteBackError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WriteBackError');
  });
});
