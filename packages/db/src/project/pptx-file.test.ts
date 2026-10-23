import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemblePptx, getPart, plainText, readPptx, rulesFor } from '@cat-tool/core';
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
  '../../../../fixtures/pptx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function projectWith(name: string) {
  dir = mkdtempSync(join(tmpdir(), 'cat-pptx-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  const file = insertFile(db, name, assemblePptx(load(name), rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  return { db, file };
}

describe('a PPTX in a project', () => {
  it('is stored as pptx, with its slides and notes as segments in reading order', () => {
    const { db, file } = projectWith('edge-cases.en.pptx');
    expect(file.kind).toBe('pptx');
    expect(getFile(db, file.id)?.kind).toBe('pptx');
    expect(listFileSummaries(db)[0]).toMatchObject({ kind: 'pptx' });
    const parts = [...new Set(listSegments(db, file.id).map((s) => s.part))];
    expect(parts).toEqual(['slide2', 'slide1', 'slide3', 'notes1', 'notes3']);
    db.close();
  });

  it('exports every part unchanged when nothing is translated', () => {
    const { db, file } = projectWith('lo-deck.en.pptx');
    const out = exportFile(db, file.id, { actor: TEST_ACTOR });
    expect(out.summary.paragraphsRendered).toBe(0);
    const before = readPptx(load('lo-deck.en.pptx'));
    const after = readPptx(out.bytes);
    for (const part of before.parts) {
      expect(
        Buffer.from(getPart(after, part.name)!).equals(Buffer.from(part.data)),
        part.name,
      ).toBe(true);
    }
    db.close();
  });

  it('carries an edit through the repository into the slide, and only that slide', () => {
    const { db, file } = projectWith('lo-deck.en.pptx');
    const title = listSegments(db, file.id).find(
      (s) => plainText(s.sourceTokens) === 'Soil and water',
    )!;
    editSegmentTarget(db, title.id, {
      tokens: [{ t: 'text', v: 'Suelo y agua' }],
      actor: TEST_ACTOR,
    });
    const out = exportFile(db, file.id, { actor: TEST_ACTOR });
    expect(out.summary).toMatchObject({ paragraphsRendered: 1, segmentsWithTarget: 1 });
    const before = readPptx(load('lo-deck.en.pptx'));
    const after = readPptx(out.bytes);
    const changed = before.parts
      .filter((p) => !Buffer.from(getPart(after, p.name)!).equals(Buffer.from(p.data)))
      .map((p) => p.name);
    expect(changed).toEqual(['ppt/slides/slide2.xml']);
    const slide = decode(getPart(after, 'ppt/slides/slide2.xml')!);
    expect(slide).toContain('<a:t>Suelo y agua</a:t>');
    // The paragraph's properties survive: end properties still close it.
    expect(slide).toMatch(/<a:t>Suelo y agua<\/a:t><\/a:r><a:endParaRPr[^>]*>/);
    db.close();
  });
});
