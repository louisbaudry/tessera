import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { capturePlans, scansOf } from '../query-plan.fixture.js';

import { createTm } from './index.js';
import { retrievePair } from './retrieve.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-retrieve-'));
  return join(dir, 'memory.ctm');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Inserts a unit with one variant per (lang, plain) pair given. */
function insertUnit(
  db: Database.Database,
  uuid: string,
  variants: ReadonlyArray<{
    lang: string;
    plain: string;
    quality?: number;
    updatedAt?: string;
  }>,
  deleted = false,
): number {
  const now = new Date().toISOString();
  const tu = db
    .prepare('INSERT INTO tu (uuid, created_at, updated_at, deleted) VALUES (?, ?, ?, ?)')
    .run(uuid, now, now, deleted ? 1 : 0);
  const tuId = tu.lastInsertRowid as number;
  for (const v of variants) {
    db.prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, quality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tuId,
      v.lang,
      JSON.stringify([{ t: 'text', v: v.plain }]),
      v.plain,
      `hash:${v.plain}`,
      v.quality ?? 1,
      v.updatedAt ?? now,
      v.updatedAt ?? now,
    );
  }
  return tuId;
}

describe('retrievePair', () => {
  it('retrieves all six directions across an EN/ES/DE memory', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    insertUnit(db, 'u1', [
      { lang: 'en', plain: 'Hello' },
      { lang: 'es', plain: 'Hola' },
      { lang: 'de', plain: 'Hallo' },
    ]);
    const langs = ['en', 'es', 'de'] as const;
    const text: Record<string, string> = { en: 'Hello', es: 'Hola', de: 'Hallo' };
    let checked = 0;
    for (const src of langs) {
      for (const tgt of langs) {
        if (src === tgt) continue;
        const matches = retrievePair(db, {
          srcLang: src,
          srcHash: `hash:${text[src]}`,
          tgtLang: tgt,
        });
        expect(matches, `${src} -> ${tgt}`).toHaveLength(1);
        expect(matches[0]!.tokens).toEqual([{ t: 'text', v: text[tgt] }]);
        checked++;
      }
    }
    expect(checked).toBe(6);
    db.close();
  });

  it('reverse lookup uses the same code path — no direction is baked in', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    // Authored EN -> ES; nothing marks EN as "the" source.
    insertUnit(db, 'u1', [
      { lang: 'en', plain: 'Good morning' },
      { lang: 'es', plain: 'Buenos días' },
    ]);
    const esToEn = retrievePair(db, {
      srcLang: 'es',
      srcHash: 'hash:Buenos días',
      tgtLang: 'en',
    });
    expect(esToEn).toHaveLength(1);
    expect(esToEn[0]!.tokens).toEqual([{ t: 'text', v: 'Good morning' }]);
    db.close();
  });

  it('region-insensitive fallback matches a bare-subtag variant', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    insertUnit(db, 'u1', [
      { lang: 'en', plain: 'Save' },
      { lang: 'es', plain: 'Guardar' }, // stored bare, no region
    ]);
    const matches = retrievePair(db, {
      srcLang: 'en',
      srcHash: 'hash:Save',
      tgtLang: 'es-ES',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.lang).toBe('es');
    expect(matches[0]!.tokens).toEqual([{ t: 'text', v: 'Guardar' }]);
    db.close();
  });

  it('region-insensitive fallback also applies to the source side', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    insertUnit(db, 'u1', [
      { lang: 'en-US', plain: 'Color' },
      { lang: 'es', plain: 'Color' },
    ]);
    // Query with the bare primary subtag; the stored source variant is regional.
    const matches = retrievePair(db, {
      srcLang: 'en',
      srcHash: 'hash:Color',
      tgtLang: 'es',
    });
    expect(matches).toHaveLength(1);
    db.close();
  });

  it('orders by quality, then recency', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    // Two different units sharing a source hash (spec §7: legitimately
    // different translations of the same sentence both survive).
    insertUnit(db, 'low-quality-old', [
      { lang: 'en', plain: 'Open' },
      {
        lang: 'es',
        plain: 'Abrir viejo',
        quality: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
    insertUnit(db, 'high-quality', [
      { lang: 'en', plain: 'Open' },
      {
        lang: 'es',
        plain: 'Abrir mejor',
        quality: 3,
        updatedAt: '2021-01-01T00:00:00.000Z',
      },
    ]);
    insertUnit(db, 'low-quality-new', [
      { lang: 'en', plain: 'Open' },
      {
        lang: 'es',
        plain: 'Abrir reciente',
        quality: 1,
        updatedAt: '2022-01-01T00:00:00.000Z',
      },
    ]);
    const matches = retrievePair(db, {
      srcLang: 'en',
      srcHash: 'hash:Open',
      tgtLang: 'es',
    });
    expect(matches.map((m) => m.tokens[0])).toEqual([
      { t: 'text', v: 'Abrir mejor' }, // quality 3 first
      { t: 'text', v: 'Abrir reciente' }, // then the more recent of the two quality-1s
      { t: 'text', v: 'Abrir viejo' },
    ]);
    db.close();
  });

  it('excludes tombstoned units', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    insertUnit(
      db,
      'gone',
      [
        { lang: 'en', plain: 'Delete me' },
        { lang: 'es', plain: 'Bórrame' },
      ],
      true,
    );
    const matches = retrievePair(db, {
      srcLang: 'en',
      srcHash: 'hash:Delete me',
      tgtLang: 'es',
    });
    expect(matches).toHaveLength(0);
    db.close();
  });

  it('returns nothing for an unknown source hash', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    insertUnit(db, 'u1', [
      { lang: 'en', plain: 'Hello' },
      { lang: 'es', plain: 'Hola' },
    ]);
    expect(
      retrievePair(db, { srcLang: 'en', srcHash: 'hash:nope', tgtLang: 'es' }),
    ).toHaveLength(0);
    db.close();
  });

  it('runs against a schema-qualified alias, for querying an ATTACHed TM from another connection', () => {
    const tmPath = dbPath();
    const db = createTm(tmPath, { name: 'x', generator: 'test' });
    insertUnit(db, 'u1', [
      { lang: 'en', plain: 'Hello' },
      { lang: 'es', plain: 'Hola' },
    ]);
    db.close();

    // A second connection with the TM ATTACHed under an alias — the
    // shape `db/project/tm-refs.ts`'s `attachTms` produces on a project
    // connection.
    const otherDir = mkdtempSync(join(tmpdir(), 'cat-retrieve-other-'));
    const other = createTm(join(otherDir, 'other.ctm'), { name: 'y', generator: 'test' });
    other.prepare(`ATTACH DATABASE ? AS tm_1`).run(tmPath);

    const matches = retrievePair(
      other,
      { srcLang: 'en', srcHash: 'hash:Hello', tgtLang: 'es' },
      { schema: 'tm_1' },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tokens).toEqual([{ t: 'text', v: 'Hola' }]);

    other.close();
    rmSync(otherDir, { recursive: true, force: true });
  });

  it('works across repeated calls on the same connection (function registered once)', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    insertUnit(db, 'u1', [
      { lang: 'en', plain: 'Hi' },
      { lang: 'es', plain: 'Hola' },
    ]);
    expect(() => {
      for (let i = 0; i < 5; i++) {
        retrievePair(db, { srcLang: 'en', srcHash: 'hash:Hi', tgtLang: 'es' });
      }
    }).not.toThrow();
    db.close();
  });

  // Backlog #19a: `primary_subtag(s.lang) = …` scanned every `tuv` row,
  // calling into JS per row — 1.7 s a lookup at 1M units
  // (tm-format-spec.md §11.2), invisible at test scale. The plan is the
  // only thing a dozen-row test can see.
  describe('index use', () => {
    // `tuv_lookup` or `tuv_ctx` — both lead with (lang, hash), and
    // which one SQLite picks is its business; a seek on either is fine.
    const SEEKS_LANG_HASH =
      /^SEARCH s USING INDEX tuv_(lookup|ctx) \(lang=\? AND hash=\?/;
    const seeded = (path = dbPath()) => {
      const db = createTm(path, { name: 'x', generator: 'test' });
      insertUnit(db, 'u1', [
        { lang: 'en-US', plain: 'Hello' },
        { lang: 'es', plain: 'Hola' },
        { lang: 'de', plain: 'Hallo' },
      ]);
      return db;
    };

    it('seeks the (lang, hash) index and never scans tuv, tu or their aliases', () => {
      const db = seeded();
      const plans = capturePlans(db, () =>
        retrievePair(db, { srcLang: 'en', srcHash: 'hash:Hello', tgtLang: 'es-ES' }),
      );
      expect(plans).toHaveLength(1);
      expect(plans[0]).toContainEqual(expect.stringMatching(SEEKS_LANG_HASH));
      expect(scansOf(plans, ['tuv', 'tu', 's', 't', 'u'])).toEqual([]);
      db.close();
    });

    it('seeks the index on an ATTACHed TM too', () => {
      const tmPath = dbPath();
      seeded(tmPath).close();
      const otherDir = mkdtempSync(join(tmpdir(), 'cat-retrieve-other-'));
      const other = createTm(join(otherDir, 'other.ctm'), {
        name: 'y',
        generator: 'test',
      });
      other.prepare(`ATTACH DATABASE ? AS tm_1`).run(tmPath);
      const plans = capturePlans(other, () =>
        retrievePair(
          other,
          { srcLang: 'en', srcHash: 'hash:Hello', tgtLang: 'es' },
          { schema: 'tm_1' },
        ),
      );
      expect(plans[0]).toContainEqual(expect.stringMatching(SEEKS_LANG_HASH));
      expect(scansOf(plans, ['tuv', 'tu', 's', 't', 'u'])).toEqual([]);
      other.close();
      rmSync(otherDir, { recursive: true, force: true });
    });

    it('reads the languages from tuv itself, not from the tm.langs projection', () => {
      const db = seeded();
      // A stale projection must not hide a stored variant.
      db.prepare(`UPDATE tm SET langs = '[]' WHERE id = 1`).run();
      expect(
        retrievePair(db, { srcLang: 'en', srcHash: 'hash:Hello', tgtLang: 'de' }),
      ).toHaveLength(1);
      db.close();
    });

    it('matches every stored spelling of the primary subtag, not just a prefix', () => {
      const db = createTm(dbPath(), { name: 'x', generator: 'test' });
      insertUnit(db, 'u1', [
        { lang: 'EN_gb', plain: 'Colour' },
        { lang: 'fr', plain: 'Couleur' },
      ]);
      insertUnit(db, 'u2', [
        { lang: 'en-US', plain: 'Colour' },
        { lang: 'fr', plain: 'Couleur US' },
      ]);
      // A lookalike that shares a prefix but not the primary subtag.
      insertUnit(db, 'u3', [
        { lang: 'eng', plain: 'Colour' },
        { lang: 'fr', plain: 'Couleur eng' },
      ]);
      const matches = retrievePair(db, {
        srcLang: 'en',
        srcHash: 'hash:Colour',
        tgtLang: 'fr',
      });
      expect(matches.map((m) => m.tokens[0])).toHaveLength(2);
      expect(matches.map((m) => m.tuId).sort()).toEqual([1, 2]);
      db.close();
    });

    it('returns nothing from an empty memory', () => {
      const db = createTm(dbPath(), { name: 'x', generator: 'test' });
      expect(
        retrievePair(db, { srcLang: 'en', srcHash: 'hash:x', tgtLang: 'es' }),
      ).toEqual([]);
      db.close();
    });
  });
});
