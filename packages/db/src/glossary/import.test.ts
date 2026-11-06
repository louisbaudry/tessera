import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseGlossaryCsv, type AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addVariant,
  createGlossary,
  GlossaryImportError,
  importGlossaryRows,
  insertTerm,
  KEEP_NOTE,
  listDecisions,
  listVariants,
  preferredVariant,
  REVIEW_NOTE,
  updateVariant,
} from './index.js';

let dir: string;
const open = (): Database.Database => {
  dir = mkdtempSync(join(tmpdir(), 'cat-glossary-import-'));
  return createGlossary(join(dir, 'g.ctg'), { name: 'g', generator: 'test' });
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ALICE: AuditActor = {
  actor: { kind: 'account', id: 3 },
  label: 'alice@example.com',
};
const HEADER = 'term,lang,rendering,status,avoid,keep';
const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function importCsv(db: Database.Database, body: string) {
  const parsed = parseGlossaryCsv(`${HEADER}\n${body}`, 'en');
  expect(parsed.refusals).toEqual([]);
  return importGlossaryRows(db, parsed.rows, { srcLang: 'en', actor: ALICE });
}

describe('importGlossaryRows', () => {
  it('writes each row as a custom decision with the actor, and each avoid as a forbidden rendering', () => {
    const db = open();
    const result = importCsv(
      db,
      'source,uk,джерело,official,джерела|першоджерело,\nclaim,uk,твердження,official,,\n',
    );
    expect(result).toEqual({
      termsCreated: 2,
      termsExisting: 0,
      renderings: 2,
      forbidden: 2,
      review: 0,
    });
    const terms = db.prepare('SELECT id FROM term ORDER BY id').all() as { id: number }[];
    const variants = listVariants(db, terms[0]!.id);
    expect(variants.map((v) => [v.lang, v.text, v.forbidden])).toEqual([
      ['en', 'source', false],
      ['uk', 'джерело', false],
      ['uk', 'джерела', true],
      ['uk', 'першоджерело', true],
    ]);
    expect(preferredVariant(db, terms[0]!.id, 'uk')?.text).toBe('джерело');
    const decisions = listDecisions(db, terms[0]!.id);
    expect(decisions.map((d) => [d.kind, d.chosen, d.decidedBy])).toEqual([
      ['custom', 'джерело', 'alice@example.com'],
      ['deprecation', 'джерела', 'alice@example.com'],
      ['deprecation', 'першоджерело', 'alice@example.com'],
    ]);
  });

  it('writes a keep row as the term itself with a note, and a review row with its own', () => {
    const db = open();
    const result = importCsv(
      db,
      'OSINT,uk,,official,,yes\nlead,uk,ведучий,review,,\nTelegram,ru,,review,,yes\n',
    );
    expect(result.review).toBe(2);
    const noteOf = (term: string, lang: string): string | null => {
      const t = db
        .prepare(`SELECT term_id FROM term_variant WHERE lang = 'en' AND text = ?`)
        .get(term) as { term_id: number };
      return listVariants(db, t.term_id).find((v) => v.lang === lang)?.note ?? null;
    };
    expect(noteOf('OSINT', 'uk')).toBe(KEEP_NOTE);
    expect(noteOf('lead', 'uk')).toBe(REVIEW_NOTE);
    expect(noteOf('Telegram', 'ru')).toBe(`${KEEP_NOTE}; ${REVIEW_NOTE}`);
    const kept = db
      .prepare(`SELECT text FROM term_variant WHERE lang = 'uk' AND note = ?`)
      .get(KEEP_NOTE);
    expect(kept).toEqual({ text: 'OSINT' });
  });

  it('adds to a term already in the glossary instead of making a second one', () => {
    const db = open();
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'en', text: 'Source' });
    addVariant(db, { termId: term.id, lang: 'fr', text: 'source' });
    const result = importCsv(db, 'source,uk,джерело,,,\n');
    expect(result).toMatchObject({ termsCreated: 0, termsExisting: 1 });
    expect(count(db, 'term')).toBe(1);
    expect(listVariants(db, term.id).map((v) => v.lang)).toEqual(['en', 'fr', 'uk']);
  });

  it('clears a rendering that was forbidden, as the one write path does for a choice', () => {
    const db = open();
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'en', text: 'source' });
    addVariant(db, { termId: term.id, lang: 'uk', text: 'джерело', forbidden: true });
    importCsv(db, 'source,uk,джерело,,,\n');
    expect(listVariants(db, term.id).find((v) => v.lang === 'uk')?.forbidden).toBe(false);
  });

  it('a second import of the same file changes no variant and adds one decision per rendering', () => {
    const db = open();
    const body = 'source,uk,джерело,review,джерела,\n';
    importCsv(db, body);
    const before = db
      .prepare('SELECT id, rev, text, note, forbidden FROM term_variant ORDER BY id')
      .all();
    importCsv(db, body);
    expect(
      db
        .prepare('SELECT id, rev, text, note, forbidden FROM term_variant ORDER BY id')
        .all(),
    ).toEqual(before);
    expect(count(db, 'term')).toBe(1);
    expect(count(db, 'term_decision')).toBe(4);
  });

  it('drops the note an import wrote when a later row is plain official', () => {
    const db = open();
    importCsv(db, 'source,uk,джерело,review,,\n');
    importCsv(db, 'source,uk,джерело,official,,\n');
    const row = db.prepare(`SELECT note FROM term_variant WHERE text = 'джерело'`).get();
    expect(row).toEqual({ note: null });
  });

  it('keeps a note a person typed: the import adds its own after it once, and clears nothing of theirs', () => {
    const db = open();
    importCsv(db, 'target,uk,ціль,,,\n');
    const person = db
      .prepare(`SELECT id FROM term_variant WHERE text = 'ціль'`)
      .get() as { id: number };
    updateVariant(db, person.id, { note: 'from the style guide' });
    const note = (): string | null =>
      (
        db.prepare(`SELECT note FROM term_variant WHERE text = 'ціль'`).get() as {
          note: string | null;
        }
      ).note;
    importCsv(db, 'target,uk,ціль,,,\n');
    expect(note()).toBe('from the style guide');
    importCsv(db, 'target,uk,ціль,review,,\n');
    expect(note()).toBe(`from the style guide; ${REVIEW_NOTE}`);
    importCsv(db, 'target,uk,ціль,review,,\n');
    expect(note()).toBe(`from the style guide; ${REVIEW_NOTE}`);
  });

  it('is all or nothing: a row the glossary refuses rolls back the rows before it, and names its line', () => {
    const db = open();
    const rows = parseGlossaryCsv(
      `${HEADER}\nsource,uk,джерело,,,\nclaim,uk,твердження,,,\n`,
      'en',
    ).rows;
    // A rendering that is only whitespace is refused by the parser; a row built by hand
    // gets past it, to prove the transaction and not the parser.
    const bad = { ...rows[1]!, line: 9, rendering: '   ' };
    expect(() =>
      importGlossaryRows(db, [rows[0]!, bad], { srcLang: 'en', actor: ALICE }),
    ).toThrow(GlossaryImportError);
    try {
      importGlossaryRows(db, [rows[0]!, bad], { srcLang: 'en', actor: ALICE });
    } catch (err) {
      expect((err as GlossaryImportError).line).toBe(9);
    }
    expect(count(db, 'term')).toBe(0);
    expect(count(db, 'term_variant')).toBe(0);
    expect(count(db, 'term_decision')).toBe(0);
  });
});
