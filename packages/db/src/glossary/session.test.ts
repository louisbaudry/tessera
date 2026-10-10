import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlossarySession, type AuditActor, type SessionFlag } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addTermFromText,
  addVariant,
  commitGlossarySession,
  createGlossary,
  insertTerm,
  listDecisions,
  listVariants,
  preferredVariant,
  TermError,
} from './index.js';

let dir: string;
const open = (): Database.Database => {
  dir = mkdtempSync(join(tmpdir(), 'cat-glossary-session-'));
  return createGlossary(join(dir, 'g.ctg'), { name: 'g', generator: 'test' });
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ALICE: AuditActor = {
  actor: { kind: 'account', id: 3 },
  label: 'alice@example.com',
};
const LANGS = { srcLang: 'en', tgtLang: 'fr' };
const flag = (term: string, over: Partial<SessionFlag> = {}): SessionFlag => ({
  key: term.toLowerCase(),
  term,
  termId: null,
  offered: [],
  firstOrd: null,
  ...over,
});
const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** An existing entry: EN "software" with FR "logiciel". */
function existingEntry(db: Database.Database): number {
  const term = insertTerm(db);
  addVariant(db, { termId: term.id, lang: 'en', text: 'software' });
  addVariant(db, { termId: term.id, lang: 'fr', text: 'logiciel' });
  return term.id;
}

describe('commitGlossarySession', () => {
  it('a session with three decided, one proposed and two skipped flags commits exactly four rows', () => {
    const db = open();
    const oldId = existingEntry(db);
    const s = new GlossarySession(LANGS, [
      flag('invoice', { offered: ['facture', 'note'], firstOrd: 4 }),
      flag('contract', { offered: ['contrat'] }),
      flag('tax', {}),
      flag('software', { termId: oldId, offered: ['logiciel'] }),
      flag('skipped one'),
      flag('skipped two'),
    ]);
    s.choose('invoice', 'facture');
    s.choose('contract', 'accord'); // custom
    s.choose('tax', 'taxe');
    s.proposeEdit('software', 'override', 'programme');
    s.skip('skipped one');

    const before = count(db, 'term_decision');
    expect(commitGlossarySession(db, s, { actor: ALICE, sourceProject: 'job-42' })).toBe(
      4,
    );
    expect(count(db, 'term_decision') - before).toBe(4);
    expect(s.status).toBe('committed');
    expect(s.remaining().map((f) => f.key)).toEqual(['skipped one', 'skipped two']);
    // Nothing of the skipped ones anywhere.
    const plains = (
      db.prepare('SELECT plain FROM term_variant').all() as { plain: string }[]
    ).map((r) => r.plain);
    expect(plains.some((p) => p.startsWith('skipped'))).toBe(false);
    db.close();
  });

  it('logs what was offered, what was taken, where, and by whom — the label', () => {
    const db = open();
    const s = new GlossarySession(LANGS, [
      flag('invoice', { offered: ['facture', 'note'], firstOrd: 4 }),
    ]);
    s.choose('invoice', 'Facture');
    commitGlossarySession(db, s, { actor: ALICE, sourceProject: 'job-42' });
    const term = (db.prepare('SELECT id FROM term').get() as { id: number }).id;
    expect(listDecisions(db, term)).toEqual([
      expect.objectContaining({
        lang: 'fr',
        chosen: 'facture',
        rejected: ['note'],
        kind: 'accepted_suggestion',
        sourceProject: 'job-42',
        sourceSegment: 4,
        decidedBy: 'alice@example.com', // not "account:3"
      }),
    ]);
    // The term is language-neutral: its EN source and FR rendering share it.
    expect(listVariants(db, term).map((v) => [v.lang, v.text])).toEqual([
      ['en', 'invoice'],
      ['fr', 'Facture'],
    ]);
    expect(preferredVariant(db, term, 'fr')?.text).toBe('Facture');
    db.close();
  });

  it('names a system job by its principal when it has no label', () => {
    const db = open();
    const s = new GlossarySession(LANGS, [flag('a')]);
    s.choose('a', 'x');
    commitGlossarySession(db, s, {
      actor: { actor: { kind: 'system', name: 'import' }, label: null },
    });
    const term = (db.prepare('SELECT id FROM term').get() as { id: number }).id;
    expect(listDecisions(db, term)[0]!.decidedBy).toBe('system:import');
    db.close();
  });

  it('reuses a live term that already has the source rendering, instead of a second one', () => {
    const db = open();
    const id = existingEntry(db);
    const s = new GlossarySession({ srcLang: 'en-GB', tgtLang: 'fr-FR' }, [
      flag('Software'), // no termId, but the glossary has it
    ]);
    s.choose('software', 'logiciel');
    commitGlossarySession(db, s, { actor: ALICE });
    expect(count(db, 'term')).toBe(1);
    expect(listDecisions(db, id)).toHaveLength(1);
    // The variant exists under 'fr': not duplicated as 'fr-FR', and `rev` untouched.
    expect(listVariants(db, id).filter((v) => v.lang.startsWith('fr'))).toEqual([
      expect.objectContaining({ lang: 'fr', text: 'logiciel', rev: 1 }),
    ]);
    // The decision names the language the variant has.
    expect(listDecisions(db, id)[0]!.lang).toBe('fr');
    db.close();
  });

  it('an override changes the preferred rendering; the old variant stays', () => {
    const db = open();
    const id = existingEntry(db);
    const s = new GlossarySession(LANGS, [flag('software', { termId: id })]);
    s.proposeEdit('software', 'override', 'programme');
    commitGlossarySession(db, s, { actor: ALICE });
    expect(preferredVariant(db, id, 'fr')?.text).toBe('programme');
    expect(listVariants(db, id).filter((v) => v.lang === 'fr')).toHaveLength(2);
    expect(listDecisions(db, id).map((d) => d.kind)).toEqual(['override']);
    db.close();
  });

  it('a deprecation forbids the rendering — rev up, the old row in history — and choosing it later clears it', () => {
    const db = open();
    const id = existingEntry(db);
    const forbid = new GlossarySession(LANGS, [flag('software', { termId: id })]);
    forbid.proposeEdit('software', 'deprecate', 'logiciel');
    commitGlossarySession(db, forbid, { actor: ALICE });
    const v = listVariants(db, id).find((x) => x.lang === 'fr')!;
    expect(v.forbidden).toBe(true);
    expect(v.rev).toBe(2);
    expect(count(db, 'term_variant_history')).toBe(1);
    expect(preferredVariant(db, id, 'fr')).toBeNull();

    const back = new GlossarySession(LANGS, [flag('software', { termId: id })]);
    back.choose('software', 'logiciel');
    commitGlossarySession(db, back, { actor: ALICE });
    expect(listVariants(db, id).find((x) => x.lang === 'fr')!.forbidden).toBe(false);
    expect(preferredVariant(db, id, 'fr')?.text).toBe('logiciel');
    expect(listDecisions(db, id).map((d) => d.kind)).toEqual(['deprecation', 'custom']);
    db.close();
  });

  it('writes all or nothing: a decision that fails takes the whole session back, and it stays open', () => {
    const db = open();
    const s = new GlossarySession(LANGS, [
      flag('good'),
      flag('ghost', { termId: 999 }), // names a term that does not exist
    ]);
    s.choose('good', 'bon');
    s.choose('ghost', 'fantôme');
    expect(() => commitGlossarySession(db, s, { actor: ALICE })).toThrow(/not live/);
    expect(count(db, 'term')).toBe(0);
    expect(count(db, 'term_variant')).toBe(0);
    expect(count(db, 'term_decision')).toBe(0);
    expect(s.status).toBe('open');
    expect(s.pending()).toHaveLength(2);
    db.close();
  });

  it('cannot commit twice: the log is not written a second time', () => {
    const db = open();
    const s = new GlossarySession(LANGS, [flag('a')]);
    s.choose('a', 'x');
    commitGlossarySession(db, s, { actor: ALICE });
    expect(() => commitGlossarySession(db, s, { actor: ALICE })).toThrow(/committed/);
    expect(count(db, 'term_decision')).toBe(1);
    db.close();
  });
});

describe('addTermFromText (backlog #129)', () => {
  const add = (db: Database.Database, source: string, target: string) =>
    addTermFromText(db, { ...LANGS, source, target, actor: ALICE, sourceProject: 'job' });

  it('creates the term, both variants and a custom decision, naming who and where', () => {
    const db = open();
    const { termId, created } = add(db, '  Invoice ', ' facture ');
    expect(created).toBe(true);
    expect(listVariants(db, termId).map((v) => [v.lang, v.text])).toEqual([
      ['en', 'Invoice'],
      ['fr', 'facture'],
    ]);
    const [decision] = listDecisions(db, termId, 'fr');
    expect(decision).toMatchObject({
      chosen: 'facture',
      kind: 'custom',
      sourceProject: 'job',
      decidedBy: 'alice@example.com',
    });
    expect(preferredVariant(db, termId, 'fr')?.text).toBe('facture');
    db.close();
  });

  it('adds to the term a source form already has, case-folded, instead of a second one', () => {
    const db = open();
    const first = add(db, 'invoice', 'facture');
    const second = add(db, 'INVOICE', 'note de frais');
    expect(second).toEqual({ termId: first.termId, created: false });
    expect(listVariants(db, first.termId).filter((v) => v.lang === 'fr')).toHaveLength(2);
    // The latest decision settles the preferred rendering.
    expect(preferredVariant(db, first.termId, 'fr')?.text).toBe('note de frais');
    db.close();
  });

  it('clears a forbidden mark on a rendering the translator now chooses, and logs the decision', () => {
    const db = open();
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'en', text: 'invoice' });
    addVariant(db, { termId: term.id, lang: 'fr', text: 'facture', forbidden: true });
    add(db, 'invoice', 'facture');
    expect(listVariants(db, term.id).find((v) => v.lang === 'fr')?.forbidden).toBe(false);
    expect(listDecisions(db, term.id, 'fr')).toHaveLength(1);
    db.close();
  });

  it('refuses a blank source or rendering and writes nothing', () => {
    const db = open();
    expect(() => add(db, '   ', 'facture')).toThrow(TermError);
    expect(() => add(db, 'invoice', ' ')).toThrow(TermError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM term').get()).toEqual({ n: 0 });
    db.close();
  });

  it('is all or nothing: a failure after the term exists leaves no term behind', () => {
    const db = open();
    db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON term_decision BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    expect(() => add(db, 'invoice', 'facture')).toThrow(/boom/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM term').get()).toEqual({ n: 0 });
    db.close();
  });
});
