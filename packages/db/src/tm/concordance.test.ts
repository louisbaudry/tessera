import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { capturePlans, scansOf } from '../query-plan.fixture.js';

import { retrieveConcordance } from './concordance.js';
import { createTm } from './index.js';
import { unit } from './unit.fixture.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-concordance-'));
  return join(dir, 'memory.ctm');
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const pair = (en: string, de: string) => [
  { lang: 'en-US', text: en },
  { lang: 'de-DE', text: de },
];
const ask = { srcLang: 'en', tgtLang: 'de' } as const;

describe('retrieveConcordance', () => {
  it('finds the units holding a phrase, newest first, with both sides', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const older = unit(db, pair('Set up the printer.', 'Richten Sie den Drucker ein.'));
    unit(db, pair('Open the lid.', 'Öffnen Sie den Deckel.'));
    const newer = unit(
      db,
      pair('How to set up a network', 'So richten Sie ein Netzwerk ein'),
    );

    const { hits, more } = retrieveConcordance(db, {
      ...ask,
      text: 'set up',
      side: 'source',
    });

    expect(more).toBe(false);
    expect(hits.map((h) => h.tuId)).toEqual([newer, older]);
    expect(hits[0]).toMatchObject({
      sourcePlain: 'How to set up a network',
      targetPlain: 'So richten Sie ein Netzwerk ein',
    });
    expect(hits[0]!.ranges).toEqual([{ start: 7, end: 13 }]);
    db.close();
  });

  it('folds case and diacritics, as the index does', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, [
      { lang: 'es', text: 'La Acción rápida' },
      { lang: 'de', text: 'Die schnelle Aktion' },
    ]);
    const { hits } = retrieveConcordance(db, {
      srcLang: 'es',
      tgtLang: 'de',
      text: 'ACCION',
      side: 'source',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ranges).toEqual([{ start: 3, end: 9 }]);
    db.close();
  });

  it('wants the words together and in order: a phrase, not an AND', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, pair('Set the thing up', 'Richten Sie es ein'));
    unit(db, pair('up set', 'hoch gesetzt'));
    const { hits } = retrieveConcordance(db, { ...ask, text: 'set up', side: 'source' });
    expect(hits).toEqual([]);
    db.close();
  });

  it('searches the target side and returns the source beside it', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, pair('Open the lid.', 'Öffnen Sie den Deckel.'));
    unit(db, pair('Close the lid.', 'Schließen Sie den Deckel.'));
    const { hits } = retrieveConcordance(db, { ...ask, text: 'deckel', side: 'target' });
    expect(hits.map((h) => h.sourcePlain)).toEqual(['Close the lid.', 'Open the lid.']);
    expect(hits[0]!.targetPlain).toBe('Schließen Sie den Deckel.');
    expect(hits[0]!.ranges).toEqual([{ start: 18, end: 24 }]);
    db.close();
  });

  it('matches a language whatever its region', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, [
      { lang: 'en-GB', text: 'Colour printer' },
      { lang: 'de-AT', text: 'Farbdrucker' },
    ]);
    const { hits } = retrieveConcordance(db, { ...ask, text: 'colour', side: 'source' });
    expect(hits).toHaveLength(1);
    db.close();
  });

  it('skips a deleted unit and a unit with nothing in the other language', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, pair('Gone item', 'Weg'), true);
    unit(db, [{ lang: 'en-US', text: 'One-sided item' }]);
    const kept = unit(db, pair('Kept item', 'Behalten'));
    const { hits } = retrieveConcordance(db, { ...ask, text: 'item', side: 'source' });
    expect(hits.map((h) => h.tuId)).toEqual([kept]);
    db.close();
  });

  it('shows the best-quality variant of the other language', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, [
      { lang: 'en', text: 'Save file' },
      { lang: 'de-DE', text: 'Datei speichern', quality: 1 },
      { lang: 'de-AT', text: 'Datei sichern', quality: 3 },
    ]);
    const { hits } = retrieveConcordance(db, { ...ask, text: 'save', side: 'source' });
    expect(hits[0]!.targetPlain).toBe('Datei sichern');
    db.close();
  });

  it('stops at the limit and says there is more', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    for (let i = 0; i < 5; i++) unit(db, pair(`Press key ${i}`, `Taste ${i} drücken`));
    const { hits, more } = retrieveConcordance(db, {
      ...ask,
      text: 'press',
      side: 'source',
      limit: 3,
    });
    expect(hits.map((h) => h.sourcePlain)).toEqual([
      'Press key 4',
      'Press key 3',
      'Press key 2',
    ]);
    expect(more).toBe(true);
    const all = retrieveConcordance(db, {
      ...ask,
      text: 'press',
      side: 'source',
      limit: 5,
    });
    expect(all.hits).toHaveLength(5);
    expect(all.more).toBe(false);
    db.close();
  });

  it('is an empty result, not an error, for a text with no word', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, pair('Hello', 'Hallo'));
    for (const text of ['', '   ', '...', '"']) {
      expect(retrieveConcordance(db, { ...ask, text, side: 'source' })).toEqual({
        hits: [],
        more: false,
      });
    }
    db.close();
  });

  it('reads FTS syntax typed by a person as plain words', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    unit(db, pair('either or', 'entweder oder'));
    for (const text of [
      'NEAR(a b)',
      'a OR b',
      'a*',
      '"unbalanced',
      'x:y',
      '-a',
      'a AND NOT b',
    ]) {
      expect(() =>
        retrieveConcordance(db, { ...ask, text, side: 'source' }),
      ).not.toThrow();
    }
    expect(
      retrieveConcordance(db, { ...ask, text: '"either" or*', side: 'source' }).hits,
    ).toHaveLength(1);
    db.close();
  });

  it('seeks the full-text index and scans no table', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    for (let i = 0; i < 20; i++) unit(db, pair(`Item ${i} text`, `Eintrag ${i}`));
    const plans = capturePlans(db, () => {
      retrieveConcordance(db, { ...ask, text: 'item', side: 'source' });
    });
    expect(scansOf(plans, ['tuv', 'm', 'u', 't'])).toEqual([]);
    expect(plans.flat().some((d) => /VIRTUAL TABLE INDEX/.test(d))).toBe(true);
    db.close();
  });
});
