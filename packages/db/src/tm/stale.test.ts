import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GlossaryTermEntry } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addVariant,
  createGlossary,
  insertTerm,
  listTermEntries,
  recordDecision,
} from '../glossary/index.js';
import { capturePlans, scansOf } from '../query-plan.fixture.js';

import { createTm } from './index.js';
import { scanTmForStale } from './stale.js';

let dir: string;
const tmPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-stale-'));
  return join(dir, 'memory.ctm');
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** One unit with an `en` source and a `de` target (or whichever pair is given). */
function unit(
  db: Database.Database,
  uuid: string,
  source: string,
  target: string,
  opts: { deleted?: boolean; src?: string; tgt?: string } = {},
): void {
  const now = new Date().toISOString();
  const id = db
    .prepare('INSERT INTO tu (uuid, created_at, updated_at, deleted) VALUES (?, ?, ?, ?)')
    .run(uuid, now, now, opts.deleted ? 1 : 0).lastInsertRowid as number;
  for (const [lang, plain] of [
    [opts.src ?? 'en', source],
    [opts.tgt ?? 'de', target],
  ] as const) {
    db.prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, quality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      lang,
      JSON.stringify([{ t: 'text', v: plain }]),
      plain,
      `${lang}:${plain}`,
      now,
      now,
    );
  }
}

const form = (text: string) => ({ text, plain: text.toLocaleLowerCase() });
/** `account` → preferred `Konto`, acceptable `Zugang`, forbidden `Account`. */
const entries: GlossaryTermEntry[] = [
  {
    termId: 1,
    source: [form('account')],
    preferred: form('Konto'),
    alternatives: [form('Zugang')],
    forbidden: [form('Account')],
  },
];
const pair = { srcLang: 'en', tgtLang: 'de' };

describe('scanTmForStale', () => {
  it('reports units that use a forbidden or a non-preferred rendering, and only those', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    unit(db, 'u1', 'Open your account.', 'Öffnen Sie Ihr Konto.'); // preferred: fine
    unit(db, 'u2', 'Close your account.', 'Schließen Sie Ihren Zugang.'); // acceptable, not preferred
    unit(db, 'u3', 'Delete your account.', 'Löschen Sie Ihren Account.'); // forbidden
    unit(db, 'u4', 'Check your account.', 'Prüfen Sie Ihr Profil.'); // a paraphrase: not stale
    unit(db, 'u5', 'Open the door.', 'Öffnen Sie die Tür.'); // no term
    const scan = scanTmForStale(db, entries, pair);
    expect(scan).toMatchObject({
      entries: 1,
      scanned: 5,
      total: 2,
      truncated: false,
      complete: true,
    });
    expect(scan.rows.map((r) => [r.tuUuid, r.kind, r.found, r.preferred])).toEqual([
      ['u2', 'missing_preferred', 'Zugang', 'Konto'],
      ['u3', 'forbidden', 'Account', 'Konto'],
    ]);
    expect(scan.rows[0]).toMatchObject({
      source: 'Close your account.',
      target: 'Schließen Sie Ihren Zugang.',
      termId: 1,
      term: 'account',
    });
    db.close();
  });

  it('skips deleted units and units that lack the pair', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    unit(db, 'gone', 'Open your account.', 'Ihren Account.', { deleted: true });
    unit(db, 'fr', 'Open your account.', 'Votre compte.', { tgt: 'fr' });
    unit(db, 'ok', 'Open your account.', 'Ihren Account.');
    const scan = scanTmForStale(db, entries, pair);
    expect(scan.scanned).toBe(2 - 1); // `ok` only: `gone` is deleted, `fr` has no de
    expect(scan.rows.map((r) => r.tuUuid)).toEqual(['ok']);
    db.close();
  });

  it('matches languages by primary subtag, as every lookup here does', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    unit(db, 'regional', 'Open your account.', 'Ihren Account.', {
      src: 'en-GB',
      tgt: 'de-DE',
    });
    expect(scanTmForStale(db, entries, pair).rows.map((r) => r.tuUuid)).toEqual([
      'regional',
    ]);
    db.close();
  });

  it('caps the rows but counts them all, and says so', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    for (let i = 0; i < 7; i++) unit(db, `u${i}`, 'Open your account.', 'Ihren Account.');
    const scan = scanTmForStale(db, entries, pair, { limit: 3 });
    expect(scan.total).toBe(7);
    expect(scan.rows).toHaveLength(3);
    expect(scan.truncated).toBe(true);
    expect(scan.rows.map((r) => r.tuUuid)).toEqual(['u0', 'u1', 'u2']); // unit order
    db.close();
  });

  it('pages through the memory and reports progress up to the last unit', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    for (let i = 0; i < 25; i++)
      unit(db, `u${i}`, 'Open your account.', 'Ihren Account.');
    const seen: Array<{ scanned: number; fraction: number | null }> = [];
    const scan = scanTmForStale(db, entries, pair, {
      batchSize: 10,
      onProgress: (p) => seen.push(p),
    });
    expect(scan.scanned).toBe(25);
    expect(seen.map((p) => p.scanned)).toEqual([10, 20, 25]);
    expect(seen[seen.length - 1]!.fraction).toBe(1);
    db.close();
  });

  it('stops between pages when asked, with what it has and complete false', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    for (let i = 0; i < 25; i++)
      unit(db, `u${i}`, 'Open your account.', 'Ihren Account.');
    let pages = 0;
    const scan = scanTmForStale(db, entries, pair, {
      batchSize: 10,
      onProgress: () => void pages++,
      shouldStop: () => pages >= 1,
    });
    expect(scan.complete).toBe(false);
    expect(scan.scanned).toBe(10);
    expect(scan.total).toBe(10);
    db.close();
  });

  it('reads nothing when the glossary has no term for the pair', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    unit(db, 'u1', 'Open your account.', 'Ihren Account.');
    expect(scanTmForStale(db, [], pair)).toMatchObject({
      entries: 0,
      scanned: 0,
      total: 0,
      complete: true,
    });
    db.close();
  });

  it('walks the units in id order and seeks each variant: no scan, no sort, at any size', () => {
    const db = createTm(tmPath(), { name: 't', generator: 'test' });
    for (let i = 0; i < 50; i++)
      unit(db, `u${i}`, 'Open your account.', 'Ihren Account.');
    const plans = capturePlans(
      db,
      () => void scanTmForStale(db, entries, pair, { batchSize: 20 }),
    );
    // The page is the statement that walks `tu` by rowid; the others are the `MAX(id)` read.
    const page = plans.filter((p) => p.some((d) => d.includes('rowid>?')));
    expect(page.length).toBeGreaterThan(0);
    for (const plan of page) {
      expect(plan).toContain('SEARCH tu USING INTEGER PRIMARY KEY (rowid>?)');
      expect(
        plan.some((d) => d.startsWith('SEARCH t USING INDEX sqlite_autoindex_tuv_1')),
      ).toBe(true);
      expect(scansOf([plan], ['tu', 'tuv', 's', 't'])).toEqual([]);
      // Ordered by the walk itself: a sort here is the whole memory per page.
      expect(plan.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
    }
    db.close();
  });
});

describe('through a real glossary', () => {
  it('finds the unit a ruling just made stale', () => {
    const memoryPath = tmPath();
    const glossary = createGlossary(join(dir, 'g.ctg'), { name: 'g', generator: 'test' });
    const term = insertTerm(glossary);
    addVariant(glossary, { termId: term.id, lang: 'en', text: 'account' });
    const konto = addVariant(glossary, { termId: term.id, lang: 'de', text: 'Konto' });
    const zugang = addVariant(glossary, { termId: term.id, lang: 'de', text: 'Zugang' });
    const tm = createTm(memoryPath, { name: 't', generator: 'test' });
    unit(tm, 'old', 'Open your account.', 'Öffnen Sie Ihr Konto.');
    unit(tm, 'new', 'Close your account.', 'Schließen Sie Ihren Zugang.');

    // Before any ruling, `Konto` is the one the glossary prefers (added first).
    const before = scanTmForStale(tm, listTermEntries(glossary, pair), pair);
    expect(before.rows.map((r) => r.tuUuid)).toEqual(['new']);

    // The client rules for `Zugang`: now the old work is the other one.
    recordDecision(glossary, {
      termId: term.id,
      lang: 'de',
      chosen: zugang.text,
      rejected: [konto.text],
      kind: 'override',
    });
    const after = scanTmForStale(tm, listTermEntries(glossary, pair), pair);
    expect(after.rows.map((r) => [r.tuUuid, r.found])).toEqual([['old', 'Konto']]);
    tm.close();
    glossary.close();
  });
});
