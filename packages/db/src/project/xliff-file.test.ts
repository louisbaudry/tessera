import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleXliff,
  plainText,
  readXliff,
  rulesFor,
  assembleFile,
} from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { editSegmentTarget } from './edit-target.js';
import { exportFile } from './export.js';
import { getFile, insertFile, listFileSummaries } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { mergeSegmentWithNext, splitSegmentAt } from './restructure.js';
import { SegmentRepoError, listSegments } from './segments.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const load = (path: string) => new Uint8Array(readFileSync(join(FIXTURES, path)));

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function projectWith(name: string) {
  dir = mkdtempSync(join(tmpdir(), 'cat-xliff-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'de' });
  const bytes = load(`xliff/${name}`);
  const file = insertFile(
    db,
    name,
    assembleXliff(bytes, { srcLang: 'en', tgtLang: 'de' }),
    {
      actor: TEST_ACTOR,
    },
  );
  return { db, file, bytes };
}

describe('an XLIFF file in a project', () => {
  it('is stored with its kind, segments and the targets it arrived with', () => {
    const { db, file } = projectWith('prefilled.en-de.xlf');
    expect(file.kind).toBe('xliff');
    expect(getFile(db, file.id)?.kind).toBe('xliff');
    expect(listFileSummaries(db)[0]).toMatchObject({ kind: 'xliff', segmentCount: 5 });

    const segments = listSegments(db, file.id);
    expect(
      segments.map((s) => [s.status, s.targetTokens ? plainText(s.targetTokens) : null]),
    ).toEqual([
      ['translated', 'Die rote Tür ist .'],
      ['draft', 'Zweimal klopfen & warten.'],
      ['translated', 'Warten.'],
      ['new', null],
      ['new', null],
    ]);
    expect(segments.every((s) => s.part === 'xliff')).toBe(true);
    db.close();
  });

  it('a DOCX is still stored as docx', () => {
    dir = mkdtempSync(join(tmpdir(), 'cat-xliff-'));
    const db = openProjectDb(join(dir, 'project.catdb'));
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'fr' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(load('docx/form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    expect(file.kind).toBe('docx');
    expect(getFile(db, file.id)?.kind).toBe('docx');
    db.close();
  });

  it('exports byte-identical when nothing is edited', () => {
    const { db, file, bytes } = projectWith('basic.en-de.xlf');
    const out = exportFile(db, file.id, { actor: TEST_ACTOR });
    expect(Buffer.from(out.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(out.summary).toMatchObject({ paragraphsRendered: 0, segmentsWithTarget: 0 });
    db.close();
  });

  it('carries an edit made through the repository into the XLIFF', () => {
    const { db, file } = projectWith('basic.en-de.xlf');
    const [first] = listSegments(db, file.id);
    editSegmentTarget(db, first!.id, {
      tokens: [{ t: 'text', v: 'Das Gartentor ist offen.' }],
      actor: TEST_ACTOR,
    });
    const out = exportFile(db, file.id, { actor: TEST_ACTOR });
    const doc = readXliff(out.bytes);
    expect(doc.segments[0]!.state).toBe('translated');
    expect(out.summary).toMatchObject({ paragraphsRendered: 1, segmentsWithTarget: 1 });
    expect(new TextDecoder().decode(out.bytes)).toContain(
      '<source>The garden gate is open.</source><target>Das Gartentor ist offen.</target>',
    );
    db.close();
  });

  it('refuses to split or merge a segment', () => {
    const { db, file } = projectWith('basic.en-de.xlf');
    const [first] = listSegments(db, file.id);
    expect(() => splitSegmentAt(db, first!.id, { offset: 4, actor: TEST_ACTOR })).toThrow(
      SegmentRepoError,
    );
    expect(() => mergeSegmentWithNext(db, first!.id, { actor: TEST_ACTOR })).toThrow(
      /XLIFF/,
    );
    db.close();
  });
});
