import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor, type Token } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  addVariant,
  createGlossary,
  insertTerm,
  openGlossary,
  recordDecision,
} from '../glossary/index.js';
import { insertFile } from './files.js';
import { addGlossaryRef } from './glossary-refs.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { dismissQaIssue, listQaIssues, runQaRules } from './qa-issues.js';
import { setRuleEnabled } from './qa-settings.js';
import { listSegments, setSegmentTarget } from './segments.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const text = (v: string): Token[] => [{ t: 'text', v }];

/**
 * An en→de project whose first segment reads "The invoice is due." and a
 * glossary with one term, invoice → Rechnung (preferred), Faktura
 * (acceptable) and Quittung (forbidden), attached as the write target.
 */
function setup(options: { attach?: boolean } = {}): {
  db: Database.Database;
  segmentId: number;
  glossaryPath: string;
} {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-glossary-qa-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'de' });
  const file = insertFile(
    db,
    'a.docx',
    assembleFile(
      new Uint8Array(readFileSync(join(FIXTURES, 'prose-short.docx'))),
      rulesFor('en'),
    ),
    { actor: TEST_ACTOR },
  );
  const segmentId = listSegments(db, file.id)[0]!.id;
  db.prepare('UPDATE segment SET source_tokens = ? WHERE id = ?').run(
    JSON.stringify(text('The invoice is due.')),
    segmentId,
  );

  const glossaryPath = join(dir, 'g.ctg');
  const g = createGlossary(glossaryPath, { name: 'g', generator: 'test' });
  const term = insertTerm(g);
  addVariant(g, { termId: term.id, lang: 'en', text: 'invoice' });
  addVariant(g, { termId: term.id, lang: 'de', text: 'Rechnung' });
  addVariant(g, { termId: term.id, lang: 'de', text: 'Faktura' });
  addVariant(g, { termId: term.id, lang: 'de', text: 'Quittung', forbidden: true });
  recordDecision(g, {
    termId: term.id,
    lang: 'de',
    chosen: 'Rechnung',
    rejected: [],
    kind: 'custom',
  });
  g.close();
  if (options.attach ?? true) {
    addGlossaryRef(db, {
      path: glossaryPath,
      priority: 1,
      isWriteTarget: true,
      actor: TEST_ACTOR,
    });
  }
  return { db, segmentId, glossaryPath };
}

const translate = (db: Database.Database, segmentId: number, target: string) =>
  setSegmentTarget(db, segmentId, {
    targetTokens: text(target),
    status: 'draft',
    origin: null,
    actor: TEST_ACTOR,
  });

const glossaryIssues = (db: Database.Database, segmentId: number) =>
  listQaIssues(db, segmentId).filter((i) => i.rule === 'term.glossary_mismatch');

describe('term.glossary_mismatch (backlog #44)', () => {
  it('passes when the target uses the preferred rendering', () => {
    const { db, segmentId } = setup();
    translate(db, segmentId, 'Die Rechnung ist fällig.');
    runQaRules(db, segmentId);
    expect(glossaryIssues(db, segmentId)).toEqual([]);
    db.close();
  });

  it('warns, naming the term and the alternative used, when the preferred is missing', () => {
    const { db, segmentId } = setup();
    translate(db, segmentId, 'Die Faktura ist fällig.');
    runQaRules(db, segmentId);
    expect(glossaryIssues(db, segmentId)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        dismissed: false,
        message: '“invoice”: expected “Rechnung” (“Faktura” used)',
      }),
    ]);
    db.close();
  });

  it('names a forbidden rendering, and never blocks delivery', () => {
    const { db, segmentId } = setup();
    translate(db, segmentId, 'Die Quittung ist fällig.');
    runQaRules(db, segmentId);
    const [issue] = glossaryIssues(db, segmentId);
    expect(issue!.message).toBe('“invoice”: forbidden rendering “Quittung” used');
    expect(issue!.severity).not.toBe('error');
    db.close();
  });

  it('is silent for an untranslated segment, with no glossary attached, and when switched off', () => {
    const untranslated = setup();
    runQaRules(untranslated.db, untranslated.segmentId);
    expect(glossaryIssues(untranslated.db, untranslated.segmentId)).toEqual([]);
    untranslated.db.close();

    const bare = setup({ attach: false });
    translate(bare.db, bare.segmentId, 'Die Faktura ist fällig.');
    runQaRules(bare.db, bare.segmentId);
    expect(glossaryIssues(bare.db, bare.segmentId)).toEqual([]);
    bare.db.close();

    const off = setup();
    setRuleEnabled(off.db, 'term.glossary_mismatch', false);
    translate(off.db, off.segmentId, 'Die Faktura ist fällig.');
    runQaRules(off.db, off.segmentId);
    expect(glossaryIssues(off.db, off.segmentId)).toEqual([]);
    off.db.close();
  });

  it('follows the glossary: a changed preference is seen by the next run', () => {
    const { db, segmentId, glossaryPath } = setup();
    translate(db, segmentId, 'Die Faktura ist fällig.');
    runQaRules(db, segmentId);
    expect(glossaryIssues(db, segmentId)).toHaveLength(1);

    const g = openGlossary(glossaryPath);
    recordDecision(g, {
      termId: 1,
      lang: 'de',
      chosen: 'Faktura',
      rejected: ['Rechnung'],
      kind: 'override',
    });
    g.close();

    runQaRules(db, segmentId);
    expect(glossaryIssues(db, segmentId)).toEqual([]);
    db.close();
  });

  it('sees a variant added after the matcher was first built', () => {
    const { db, segmentId, glossaryPath } = setup();
    translate(db, segmentId, 'Die Rechnung ist f\u00e4llig, Beleg beigef\u00fcgt.');
    runQaRules(db, segmentId);
    expect(glossaryIssues(db, segmentId)).toEqual([]);

    const g = openGlossary(glossaryPath);
    addVariant(g, { termId: 1, lang: 'de', text: 'Beleg', forbidden: true });
    g.close();

    runQaRules(db, segmentId);
    expect(glossaryIssues(db, segmentId)[0]!.message).toContain('\u201CBeleg\u201D');
    db.close();
  });

  it('keeps a dismissal through a rerun, like every rule', () => {
    const { db, segmentId } = setup();
    translate(db, segmentId, 'Die Faktura ist fällig.');
    runQaRules(db, segmentId);
    dismissQaIssue(
      db,
      { segmentId, rule: 'term.glossary_mismatch' },
      { actor: TEST_ACTOR },
    );
    runQaRules(db, segmentId);
    expect(glossaryIssues(db, segmentId)[0]!.dismissed).toBe(true);
    db.close();
  });

  it('is silent, not an error, when the glossary file is gone', () => {
    const { db, segmentId, glossaryPath } = setup();
    rmSync(glossaryPath);
    translate(db, segmentId, 'Die Faktura ist fällig.');
    expect(() => runQaRules(db, segmentId)).not.toThrow();
    expect(glossaryIssues(db, segmentId)).toEqual([]);
    db.close();
  });
});
