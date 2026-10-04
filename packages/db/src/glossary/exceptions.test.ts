import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXCEPTION_PROPOSAL_MIN } from '@cat-tool/core';
import type { Database } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acceptExceptionProposal,
  addVariant,
  createGlossary,
  insertTerm,
  listExceptionProposals,
  preferredVariant,
  recordDecision,
  recordSegmentException,
  TermError,
  updateVariant,
} from './index.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A term "invoice" with two German renderings, the first settled as preferred. */
function setup(): { db: Database; termId: number } {
  dir = mkdtempSync(join(tmpdir(), 'cat-glossary-exc-'));
  const db = createGlossary(join(dir, 'g.ctg'), { name: 'g', generator: 'test' });
  const term = insertTerm(db);
  addVariant(db, { termId: term.id, lang: 'en', text: 'invoice' });
  addVariant(db, { termId: term.id, lang: 'de', text: 'Rechnung' });
  addVariant(db, { termId: term.id, lang: 'de', text: 'Faktura' });
  recordDecision(db, {
    termId: term.id,
    lang: 'de',
    chosen: 'Rechnung',
    rejected: [],
    kind: 'custom',
  });
  return { db, termId: term.id };
}

const record = (
  db: Database,
  termId: number,
  segment: number,
  project = 'p',
  chosen = 'Faktura',
) =>
  recordSegmentException(db, {
    termId,
    lang: 'de-DE',
    chosen,
    sourceProject: project,
    sourceSegment: segment,
    decidedBy: 'Ana',
  });

// SQLite-heavy: a fixed 5 s starved out on the 2-fork Windows runner (#82), so the suite
// gets the slack the other heavy suites have.
describe('recordSegmentException', { timeout: 60_000 }, () => {
  it('never moves the preference, however often it is recorded', () => {
    const { db, termId } = setup();
    for (let i = 0; i < 10; i++) record(db, termId, i);
    expect(preferredVariant(db, termId, 'de')?.text).toBe('Rechnung');
    db.close();
  });

  it('refuses the preferred rendering, a forbidden one and one the entry does not hold', () => {
    const { db, termId } = setup();
    expect(() => record(db, termId, 1, 'p', 'Rechnung')).toThrow(/already the preferred/);
    expect(() => record(db, termId, 1, 'p', 'Beleg')).toThrow(TermError);
    const faktura = db
      .prepare("SELECT id FROM term_variant WHERE plain = 'faktura'")
      .get() as {
      id: number;
    };
    updateVariant(db, faktura.id, { forbidden: true, updatedBy: 'x' });
    expect(() => record(db, termId, 1)).toThrow(/not an acceptable rendering/);
    db.close();
  });

  it('writes who, where and what it displaced, in the term’s own language spelling', () => {
    const { db, termId } = setup();
    record(db, termId, 7);
    expect(
      db
        .prepare(
          "SELECT lang, chosen, rejected, kind, source_project, source_segment, decided_by FROM term_decision WHERE kind = 'segment_exception'",
        )
        .all(),
    ).toEqual([
      {
        lang: 'de',
        chosen: 'faktura',
        rejected: '["rechnung"]',
        kind: 'segment_exception',
        source_project: 'p',
        source_segment: 7,
        decided_by: 'Ana',
      },
    ]);
    db.close();
  });
});

// SQLite-heavy: a fixed 5 s starved out on the 2-fork Windows runner (#82), so the suite
// gets the slack the other heavy suites have.
describe('listExceptionProposals', { timeout: 60_000 }, () => {
  it(`proposes an alternative once it is recorded for ${EXCEPTION_PROPOSAL_MIN} distinct segments`, () => {
    const { db, termId } = setup();
    record(db, termId, 1);
    record(db, termId, 2);
    expect(listExceptionProposals(db)).toEqual([]);
    record(db, termId, 3);
    expect(listExceptionProposals(db)).toEqual([
      { termId, lang: 'de', chosen: 'Faktura', preferred: 'Rechnung', segments: 3 },
    ]);
    db.close();
  });

  it('counts distinct segments: the same one recorded again adds nothing', () => {
    const { db, termId } = setup();
    for (let i = 0; i < 5; i++) record(db, termId, 1);
    record(db, termId, 2);
    expect(listExceptionProposals(db)).toEqual([]);
    expect(listExceptionProposals(db, { min: 2 })).toMatchObject([{ segments: 2 }]);
    db.close();
  });

  it('counts segments of different projects separately', () => {
    const { db, termId } = setup();
    record(db, termId, 1, 'a');
    record(db, termId, 1, 'b');
    record(db, termId, 1, 'c');
    expect(listExceptionProposals(db)).toHaveLength(1);
    db.close();
  });

  it('starts again after a ruling: a later decision for the term forgets the earlier exceptions', () => {
    const { db, termId } = setup();
    for (let i = 1; i <= 3; i++) record(db, termId, i);
    recordDecision(db, {
      termId,
      lang: 'de',
      chosen: 'Rechnung',
      rejected: [],
      kind: 'override',
    });
    expect(listExceptionProposals(db)).toEqual([]);
    record(db, termId, 4);
    expect(listExceptionProposals(db)).toEqual([]);
    db.close();
  });
});

// SQLite-heavy: a fixed 5 s starved out on the 2-fork Windows runner (#82), so the suite
// gets the slack the other heavy suites have.
describe('acceptExceptionProposal', { timeout: 60_000 }, () => {
  it('writes an override that makes the alternative preferred, and the proposal ends', () => {
    const { db, termId } = setup();
    for (let i = 1; i <= 3; i++) record(db, termId, i);
    acceptExceptionProposal(db, {
      termId,
      lang: 'de',
      chosen: 'faktura',
      decidedBy: 'Louis',
    });
    expect(preferredVariant(db, termId, 'de')?.text).toBe('Faktura');
    expect(listExceptionProposals(db)).toEqual([]);
    expect(
      db
        .prepare('SELECT kind, decided_by FROM term_decision ORDER BY id DESC LIMIT 1')
        .get(),
    ).toEqual({ kind: 'override', decided_by: 'Louis' });
    db.close();
  });

  it('refuses what nothing proposes (a stale tab), writing nothing', () => {
    const { db, termId } = setup();
    record(db, termId, 1);
    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM term_decision').get() as { n: number }
    ).n;
    expect(() =>
      acceptExceptionProposal(db, {
        termId,
        lang: 'de',
        chosen: 'Faktura',
        decidedBy: 'x',
      }),
    ).toThrow(/nothing proposes/);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM term_decision').get() as { n: number }).n,
    ).toBe(before);
    db.close();
  });
});
