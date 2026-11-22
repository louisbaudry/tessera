/**
 * An XLSX through the repository (`v1-spec.md` §3.10; issue #169): stored by
 * kind, exported unchanged when nothing is translated, and an edit carried into
 * the shared strings alone, hidden tags and all.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleXlsx, getPart, plainText, readXlsx, rulesFor } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { editSegmentTarget } from './edit-target.js';
import { exportFile } from './export.js';
import { getFile, insertFile, listFileSummaries } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { listSegments } from './segments.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/xlsx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function projectWith(name: string) {
  dir = mkdtempSync(join(tmpdir(), 'cat-xlsx-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  const file = insertFile(db, name, assembleXlsx(load(name), rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  return { db, file };
}

const changedParts = (name: string, bytes: Uint8Array): string[] => {
  const after = readXlsx(bytes);
  return readXlsx(load(name))
    .parts.filter(
      (p) => !Buffer.from(getPart(after, p.name)!).equals(Buffer.from(p.data)),
    )
    .map((p) => p.name);
};

describe('an XLSX in a project', () => {
  it('is stored as xlsx, its strings as segments of strings and sheet<n>', () => {
    const { db, file } = projectWith('edge-cases.en.xlsx');
    expect(file.kind).toBe('xlsx');
    expect(getFile(db, file.id)?.kind).toBe('xlsx');
    expect(listFileSummaries(db)[0]).toMatchObject({ kind: 'xlsx' });
    const segments = listSegments(db, file.id);
    expect([...new Set(segments.map((s) => s.part))]).toEqual(['strings', 'sheet3']);
    // A table's header and totals rows, and the text cell that is only digits.
    expect(
      segments.filter((s) => s.locked).map((s) => plainText(s.sourceTokens)),
    ).toEqual(['Dish', 'Price', 'Total', '2026']);
    db.close();
  });

  it('exports every part unchanged when nothing is translated', () => {
    for (const name of ['edge-cases.en.xlsx', 'lo-book.en.xlsx']) {
      const { db, file } = projectWith(name);
      const out = exportFile(db, file.id, { actor: TEST_ACTOR });
      expect(out.summary.paragraphsRendered).toBe(0);
      expect(changedParts(name, out.bytes), name).toEqual([]);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries an edit through the repository into the shared strings, and only them', () => {
    const { db, file } = projectWith('lo-book.en.xlsx');
    const cell = listSegments(db, file.id).find(
      (s) => plainText(s.sourceTokens) === 'Soil sampling',
    )!;
    editSegmentTarget(db, cell.id, {
      tokens: [{ t: 'text', v: 'Muestreo de suelo' }],
      actor: TEST_ACTOR,
    });
    const out = exportFile(db, file.id, { actor: TEST_ACTOR });
    expect(out.summary).toMatchObject({ paragraphsRendered: 1, segmentsWithTarget: 1 });
    expect(changedParts('lo-book.en.xlsx', out.bytes)).toEqual(['xl/sharedStrings.xml']);
    expect(decode(getPart(readXlsx(out.bytes), 'xl/sharedStrings.xml')!)).toContain(
      '<si><t>Muestreo de suelo</t></si>',
    );
    db.close();
  });

  it('gives a rich string back as runs when the target places only the tag it was shown', () => {
    const { db, file } = projectWith('lo-book.en.xlsx');
    const [first, second] = listSegments(db, file.id).filter(
      (s) =>
        plainText(s.sourceTokens).includes('sturdy boots') ||
        plainText(s.sourceTokens).includes('The ground is wet'),
    );
    // The translator sees one tag (bold); the two font-only runs are hidden and carried.
    const bold = first!.formatTable.find((f) => f.visible)!;
    editSegmentTarget(db, first!.id, {
      tokens: [
        { t: 'text', v: 'Traiga ' },
        { t: 'open', id: bold.id, fmt: bold.id },
        { t: 'text', v: 'botas resistentes' },
        { t: 'close', id: bold.id },
        { t: 'text', v: ' y un sombrero.' },
      ],
      actor: TEST_ACTOR,
    });
    editSegmentTarget(db, second!.id, {
      tokens: [{ t: 'text', v: 'El suelo está mojado por la mañana.' }],
      actor: TEST_ACTOR,
    });
    const out = exportFile(db, file.id, { actor: TEST_ACTOR });
    const strings = decode(getPart(readXlsx(out.bytes), 'xl/sharedStrings.xml')!);
    const rich = /<si>(?:(?!<\/si>)[\s\S])*botas resistentes[\s\S]*?<\/si>/.exec(
      strings,
    )![0];
    // Runs only, each with at most one rPr and exactly one t: what the schema asks.
    expect(rich).toMatch(
      /^<si>(<r>(<rPr>[\s\S]*?<\/rPr>)?<t[^>]*>[^<]*<\/t><\/r>)+<\/si>$/,
    );
    expect(rich).toContain('<b val="true"/>');
    expect(rich.replace(/<[^>]+>/g, '')).toBe(
      'Traiga botas resistentes y un sombrero. El suelo está mojado por la mañana.',
    );
    db.close();
  });
});
