import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashOf } from '@cat-tool/core';
import type { TmToken } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { exportTmx } from './export-tmx.js';
import { createTm } from './index.js';
import { importTmx } from './import-tmx.js';
import { retrievePair } from './retrieve.js';
import { writeBack } from './write.js';

let dir: string;
const dbPath = (name = 'memory') => {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'cat-export-tmx-'));
  return join(dir, `${name}.ctm`);
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const text = (v: string): TmToken[] => [{ t: 'text', v }];

describe('exportTmx', () => {
  it('exports zero units from a fresh memory as a still-valid, empty TMX document', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const result = exportTmx(db);
    expect(result.tuCount).toBe(0);
    expect(result.tuvCount).toBe(0);
    expect(result.xml).toContain('<tmx version="1.4">');
    db.close();
  });

  it('round-trips a written-back unit through a fresh .ctm: tokens, quality, context, uuid all restored', () => {
    const db = createTm(dbPath('source'), { name: 'x', generator: 'test' });
    const bold: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'Guardar' },
      { t: 'close', id: 1 },
    ];
    writeBack(db, {
      source: {
        lang: 'en',
        tokens: text('Save'),
        prevHash: 'hash-before',
        nextHash: 'hash-after',
      },
      target: { lang: 'es', tokens: bold },
    });
    db.prepare("UPDATE tuv SET quality = 4 WHERE lang = 'es'").run();

    const { xml, tuCount, tuvCount } = exportTmx(db);
    expect(tuCount).toBe(1);
    expect(tuvCount).toBe(2);
    db.close();

    const fresh = createTm(dbPath('reimported'), { name: 'y', generator: 'test' });
    importTmx(fresh, xml);
    const matches = retrievePair(fresh, {
      srcLang: 'en',
      srcHash: hashOf('Save'),
      tgtLang: 'es',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tokens).toEqual(bold);
    expect(matches[0]!.quality).toBe(4);

    const row = fresh
      .prepare("SELECT prev_hash, next_hash FROM tuv WHERE lang = 'en'")
      .get() as {
      prev_hash: string | null;
      next_hash: string | null;
    };
    expect(row).toEqual({ prev_hash: 'hash-before', next_hash: 'hash-after' });
    fresh.close();
  });

  it('restores the same tu across languages onto one unit — not flattened by round-tripping', () => {
    const db = createTm(dbPath('source'), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'de', tokens: text('Speichern') },
    });
    const { xml } = exportTmx(db);
    db.close();

    const fresh = createTm(dbPath('reimported'), { name: 'y', generator: 'test' });
    importTmx(fresh, xml);
    const langs = fresh.prepare('SELECT langs FROM tm').get() as { langs: string };
    expect(JSON.parse(langs.langs)).toEqual(['de', 'en', 'es']);
    expect(fresh.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 1 });
    fresh.close();
  });

  it('applies the language filter, dropping a unit entirely when none of its variants match', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    writeBack(db, {
      source: { lang: 'fr', tokens: text('Bonjour') },
      target: { lang: 'de', tokens: text('Hallo') },
    });

    const filtered = exportTmx(db, { langs: ['en', 'es'] });
    expect(filtered.tuCount).toBe(1);
    expect(filtered.tuvCount).toBe(2);
    expect(filtered.xml).not.toContain('xml:lang="fr"');
    expect(filtered.xml).not.toContain('xml:lang="de"');
    db.close();
  });

  it('preserves a tuid/note/prop tu_attr set through a re-import', () => {
    const db = createTm(dbPath('source'), { name: 'x', generator: 'test' });
    const { tuId } = writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    db.prepare('INSERT INTO tu_attr (tu_id, key, value) VALUES (?, ?, ?)').run(
      tuId,
      'tuid',
      'legacy-id-42',
    );
    db.prepare('INSERT INTO tu_attr (tu_id, key, value) VALUES (?, ?, ?)').run(
      tuId,
      'note',
      'reviewed by QA',
    );
    db.prepare('INSERT INTO tu_attr (tu_id, key, value) VALUES (?, ?, ?)').run(
      tuId,
      'client',
      'Acme Corp',
    );

    const { xml } = exportTmx(db);
    db.close();

    const fresh = createTm(dbPath('reimported'), { name: 'y', generator: 'test' });
    importTmx(fresh, xml);
    const attrs = fresh.prepare('SELECT key, value FROM tu_attr ORDER BY key').all();
    expect(attrs).toEqual([
      { key: 'client', value: 'Acme Corp' },
      { key: 'note', value: 'reviewed by QA' },
      { key: 'tuid', value: 'legacy-id-42' },
    ]);
    fresh.close();
  });

  it('excludes a tombstoned (deleted) tu from the export', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const { tuId } = writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') },
    });
    db.prepare('UPDATE tu SET deleted = 1 WHERE id = ?').run(tuId);
    const result = exportTmx(db);
    expect(result.tuCount).toBe(0);
    db.close();
  });

  it('exports the current revision only — a historized tuv_history entry never appears', () => {
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
    writeBack(db, {
      source: { lang: 'en', tokens: text('Save') },
      target: { lang: 'es', tokens: text('Guardar') }, // tags dropped -> historized
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv_history').get()).toEqual({ n: 1 });

    const { xml, tuvCount } = exportTmx(db);
    expect(tuvCount).toBe(2); // current revision only: one en, one es
    expect(xml).not.toContain('type="b"'); // the bold revision was superseded, not exported
    db.close();
  });
});
