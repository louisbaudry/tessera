import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeText } from '@cat-tool/core';

import { capturePlans, scansOf } from '../query-plan.fixture.js';

import { ftsQuery, retrieveFuzzy } from './fuzzy.js';
import { createTm } from './index.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-fuzzy-'));
  return join(dir, 'memory.ctm');
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function unit(
  db: Database.Database,
  pairs: ReadonlyArray<{ lang: string; text: string; quality?: number }>,
  deleted = false,
): number {
  const now = new Date().toISOString();
  const tuId = db
    .prepare('INSERT INTO tu (uuid, created_at, updated_at, deleted) VALUES (?, ?, ?, ?)')
    .run(`u${Math.random()}`, now, now, deleted ? 1 : 0).lastInsertRowid as number;
  for (const p of pairs) {
    const plain = normalizeText(p.text);
    db.prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, quality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tuId,
      p.lang,
      JSON.stringify([{ t: 'text', v: p.text }]),
      plain,
      `h:${p.lang}:${plain}`,
      p.quality ?? 1,
      now,
      now,
    );
  }
  return tuId;
}

const pair = (en: string, de: string, quality?: number) => [
  { lang: 'en-US', text: en, quality },
  { lang: 'de-DE', text: de, quality },
];
const source = (plain: string) => ({ plain, tagSlots: [] as string[] });
const ask = { srcLang: 'en', tgtLang: 'de' };

describe('retrieveFuzzy', () => {
  it('returns the closest unit first, with its score and target', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    unit(db, pair('Open the file menu and choose save', 'Öffnen Sie das Dateimenü'));
    unit(
      db,
      pair('Open the file menu and choose print', 'Drucken Sie über das Dateimenü'),
    );
    unit(db, pair('Completely unrelated sentence here', 'Ganz anderer Satz'));

    const found = retrieveFuzzy(db, {
      ...ask,
      source: source('Open the file menu and choose save as'),
    });

    expect(found.map((m) => m.score)).toEqual([87, 75]);
    expect(found[0]!.tokens).toEqual([{ t: 'text', v: 'Öffnen Sie das Dateimenü' }]);
    expect(found[0]!.sourcePlain).toBe('Open the file menu and choose save');
  });

  it('honours the minimum score and the limit', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    unit(db, pair('Open the file menu and choose save', 'a'));
    unit(db, pair('Open the file menu and choose print', 'b'));
    const s = source('Open the file menu and choose save as');
    expect(
      retrieveFuzzy(db, { ...ask, source: s, minScore: 80 }).map((m) => m.score),
    ).toEqual([87]);
    expect(retrieveFuzzy(db, { ...ask, source: s, limit: 1 })).toHaveLength(1);
  });

  it('matches the pair by primary subtag, and ignores other pairs and tombstones', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    unit(db, [
      { lang: 'en-GB', text: 'Open the file menu and choose save' },
      { lang: 'de', text: 'a' },
    ]);
    // Same source, but no German variant: skipped.
    unit(db, [
      { lang: 'en-US', text: 'Open the file menu and choose save' },
      { lang: 'fr-FR', text: 'b' },
    ]);
    // A tombstone.
    unit(db, pair('Open the file menu and choose save', 'c'), true);

    const found = retrieveFuzzy(db, {
      ...ask,
      source: source('Open the file menu and choose save now'),
    });
    expect(found.map((m) => m.lang)).toEqual(['de']);
  });

  it('breaks a score tie by quality', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    unit(db, pair('Open the file menu and choose save', 'weak', 1));
    unit(db, pair('Open the file menu and choose save', 'strong', 3));
    const found = retrieveFuzzy(db, {
      ...ask,
      source: source('Open the file menu and choose save as'),
    });
    expect(found.map((m) => m.tokens)).toEqual([
      [{ t: 'text', v: 'strong' }],
      [{ t: 'text', v: 'weak' }],
    ]);
  });

  it('finds nothing for a text with no words', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    unit(db, pair('Hello world', 'Hallo Welt'));
    expect(retrieveFuzzy(db, { ...ask, source: source('...') })).toEqual([]);
  });

  it('reads an attached memory through the schema option', () => {
    const path = dbPath();
    const db = createTm(path, { name: 'x', generator: 'test' });
    unit(db, pair('Open the file menu and choose save', 'Öffnen'));
    db.close();
    const host = createTm(join(dir, 'host.ctm'), { name: 'host', generator: 'test' });
    host.prepare('ATTACH DATABASE ? AS other').run(path);
    const found = retrieveFuzzy(
      host,
      { ...ask, source: source('Open the file menu and choose save as') },
      { schema: 'other' },
    );
    expect(found).toHaveLength(1);
  });

  it('finds a unit through an accented word the index has folded', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    unit(db, [
      { lang: 'es', text: 'El árbol está aquí junto al río grande' },
      { lang: 'de', text: 'b' },
    ]);
    expect(
      retrieveFuzzy(db, {
        srcLang: 'es',
        tgtLang: 'de',
        source: source('El árbol está aquí junto al río'),
      }).map((m) => m.score),
    ).toEqual([87]);
  });

  it('still answers on a connection that cannot make a vocabulary table', () => {
    const path = dbPath();
    const db = createTm(path, { name: 'x', generator: 'test' });
    unit(db, pair('Open the file menu and choose save', 'a'));
    db.pragma('query_only = 1');
    expect(
      retrieveFuzzy(db, {
        ...ask,
        source: source('Open the file menu and choose save as'),
      }),
    ).toHaveLength(1);
  });

  it('seeks the FTS index and never scans tuv', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    unit(db, pair('Open the file menu and choose save', 'a'));
    const plans = capturePlans(db, () => {
      retrieveFuzzy(db, {
        ...ask,
        source: source('Open the file menu and choose save as'),
      });
    });
    expect(scansOf(plans, ['tuv', 's', 'u', 't'])).toEqual([]);
    expect(plans.flat().some((d) => /VIRTUAL TABLE INDEX/.test(d))).toBe(true);
  });
});

describe('ftsQuery', () => {
  it('takes the rarest words that fit the posting budget, and at least two', () => {
    const docs = (w: string) =>
      ({ the: 90_000, file: 18_000, save: 4_000, zzz: 10 })[w] ?? 100;
    // zzz (10) and the unknown words (100 each) come first, then save (4,000);
    // file would take it past 20,000 postings, and `the` far past.
    expect(ftsQuery('the file save zzz foo bar', docs)).toBe(
      '"zzz" OR "bar" OR "foo" OR "save"',
    );
    // Two common words are still asked about, over budget: a segment of
    // them has nothing else to go on.
    expect(ftsQuery('the file', docs)).toBe('"file" OR "the"');
  });

  it('uses at most twelve words', () => {
    const text = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    expect(ftsQuery(text, () => 1)!.split(' OR ')).toHaveLength(12);
  });

  it('quotes the longest distinct words, so punctuation is never query syntax', () => {
    expect(ftsQuery('Save "as" -- AND file* now')).toBe(
      '"file" OR "save" OR "and" OR "now" OR "as"',
    );
    expect(ftsQuery('...')).toBeNull();
  });
});
