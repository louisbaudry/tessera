import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  assembleXliff,
  importDocx,
  readDocx,
  rulesFor,
  translatableSegments,
} from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { listEvents } from '../audit/events.js';
import { exportFile, ProjectExportError } from './export.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { listSegments, setSegmentTarget } from './segments.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const loadDocx = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const partDigests = (bytes: Uint8Array): Map<string, string> =>
  new Map(readDocx(bytes).parts.map((p) => [p.name, digest(p.data)]));

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function projectWith(name: string) {
  dir = mkdtempSync(join(tmpdir(), 'cat-export-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'fr' });
  const bytes = loadDocx(name);
  const file = insertFile(db, name, assembleFile(bytes, rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  return { db, file, bytes };
}

describe('exportFile', () => {
  it('reproduces the original bytes part for part when nothing is translated', () => {
    const { db, file, bytes } = projectWith('form-minimal.docx');
    const result = exportFile(db, file.id, { actor: TEST_ACTOR });
    expect(result.file.relPath).toBe('form-minimal.docx');
    expect(result.summary.paragraphsRendered).toBe(0);
    expect(partDigests(result.bytes)).toEqual(partDigests(bytes));
    db.close();
  });

  it('carries a target set through the repository into the document', () => {
    const { db, file, bytes } = projectWith('form-minimal.docx');
    const plain = listSegments(db, file.id).find(
      (s) => !s.locked && s.sourceTokens.every((t) => t.t === 'text'),
    )!;
    setSegmentTarget(db, plain.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'TRADUIT' }],
      status: 'translated',
      origin: 'tm_exact',
    });

    const { bytes: out, summary } = exportFile(db, file.id, { actor: TEST_ACTOR });
    expect(summary.paragraphsRendered).toBe(1);
    expect(summary.segmentsWithTarget).toBe(1);
    const texts = translatableSegments(importDocx(out)).map((s) => s.text);
    expect(texts.some((t) => t.includes('TRADUIT'))).toBe(true);
    expect(texts.length).toBe(translatableSegments(importDocx(bytes)).length);
    db.close();
  });

  describe('the reviewed state (issue #358)', () => {
    const XLIFF = new Uint8Array(
      readFileSync(join(FIXTURES, '../xliff/basic.en-de.xlf')),
    );
    function xliffProject() {
      dir = mkdtempSync(join(tmpdir(), 'cat-export-'));
      const db = openProjectDb(join(dir, 'project.catdb'));
      createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'de' });
      const file = insertFile(
        db,
        'basic.en-de.xlf',
        assembleXliff(XLIFF, { srcLang: 'en', tgtLang: 'de' }),
        {
          actor: TEST_ACTOR,
        },
      );
      const seg = listSegments(db, file.id).find((s) => !s.locked)!;
      setSegmentTarget(db, seg.id, {
        actor: TEST_ACTOR,
        targetTokens: [{ t: 'text', v: 'Das Gartentor ist offen.' }],
        status: 'confirmed',
        origin: null,
      });
      return { db, file };
    }
    const exportedDetails = (db: ReturnType<typeof openProjectDb>) =>
      listEvents(db, { subjectType: 'file' })
        .filter((e) => e.action === 'project.exported')
        .map((e) => (typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail));

    it('writes final for confirmed segments when asked, and records that in the event', () => {
      const { db, file } = xliffProject();
      const plain = exportFile(db, file.id, { actor: TEST_ACTOR });
      const asked = exportFile(db, file.id, { actor: TEST_ACTOR, reviewedState: true });
      const text = (b: Uint8Array) => new TextDecoder().decode(b);
      expect(text(plain.bytes)).not.toContain('state="final"');
      expect(text(asked.bytes)).toContain('state="final"');
      expect(exportedDetails(db)).toEqual([
        { sha256: plain.sha256 },
        { sha256: asked.sha256, reviewedState: true },
      ]);
      db.close();
    });

    it('is ignored, and not logged, for a DOCX, which has no such state', () => {
      const { db, file } = projectWith('form-minimal.docx');
      const plain = exportFile(db, file.id, { actor: TEST_ACTOR });
      const asked = exportFile(db, file.id, { actor: TEST_ACTOR, reviewedState: true });
      expect(asked.sha256).toBe(plain.sha256);
      expect(exportedDetails(db)).toEqual([
        { sha256: plain.sha256 },
        { sha256: plain.sha256 },
      ]);
      db.close();
    });
  });

  it('refuses an unknown file id', () => {
    const { db, file } = projectWith('form-minimal.docx');
    expect(() => exportFile(db, file.id + 1, { actor: TEST_ACTOR })).toThrow(
      ProjectExportError,
    );
    db.close();
  });
});
