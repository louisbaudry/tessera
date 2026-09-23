import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import {
  getSegment,
  listAllSegments,
  listSegments,
  setSegmentTarget,
  SegmentRepoError,
} from './segments.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const loadDocx = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-repo-'));
  return join(dir, 'project.catdb');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('getSegment / listSegments / listAllSegments', () => {
  it('lists a file’s segments in document order', () => {
    const db = openProjectDb(dbPath());
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
    );
    const segments = listSegments(db, file.id);
    expect(segments.map((s) => s.ord)).toEqual(segments.map((_, i) => i));
    expect(getSegment(db, segments[0]!.id)).toEqual(segments[0]);
    expect(getSegment(db, 999_999)).toBeNull();
    db.close();
  });

  it('every fresh segment starts untranslated, with the right status', () => {
    const db = openProjectDb(dbPath());
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
    );
    for (const segment of listSegments(db, file.id)) {
      expect(segment.targetTokens).toBeNull();
      expect(segment.origin).toBeNull();
      expect(segment.status).toBe(segment.locked ? 'locked' : 'new');
    }
    db.close();
  });

  it('spans every file in the project, grouped by file', () => {
    const db = openProjectDb(dbPath());
    const a = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
    );
    const b = insertFile(
      db,
      'b.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
    );
    const all = listAllSegments(db);
    expect(all).toHaveLength(
      listSegments(db, a.id).length + listSegments(db, b.id).length,
    );
    expect(all.every((s) => s.fileId === a.id || s.fileId === b.id)).toBe(true);
    db.close();
  });
});

describe('setSegmentTarget', () => {
  it('sets target, status, and origin together, and bumps updated_at', async () => {
    const db = openProjectDb(dbPath());
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
    );
    const [segment] = listSegments(db, file.id);
    const before = segment!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    setSegmentTarget(db, segment!.id, {
      targetTokens: [{ t: 'text', v: 'Una traducción' }],
      status: 'translated',
      origin: 'tm_exact',
    });

    const after = getSegment(db, segment!.id)!;
    expect(after.targetTokens).toEqual([{ t: 'text', v: 'Una traducción' }]);
    expect(after.status).toBe('translated');
    expect(after.origin).toBe('tm_exact');
    expect(after.updatedAt).not.toBe(before);
    db.close();
  });

  it('accepts an open-ended origin string not in the known-origin list', () => {
    const db = openProjectDb(dbPath());
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
    );
    const [segment] = listSegments(db, file.id);
    expect(() =>
      setSegmentTarget(db, segment!.id, {
        targetTokens: [{ t: 'text', v: 'x' }],
        status: 'draft',
        origin: 'tm_fuzzy_85',
      }),
    ).not.toThrow();
    db.close();
  });

  it('refuses a locked segment', () => {
    const db = openProjectDb(dbPath());
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
    );
    const locked = listSegments(db, file.id).find((s) => s.locked)!;
    expect(locked).toBeDefined();
    expect(() =>
      setSegmentTarget(db, locked.id, {
        targetTokens: [{ t: 'text', v: 'x' }],
        status: 'translated',
        origin: null,
      }),
    ).toThrow(SegmentRepoError);
    db.close();
  });

  it('refuses an unknown segment id', () => {
    const db = openProjectDb(dbPath());
    expect(() =>
      setSegmentTarget(db, 999_999, { targetTokens: null, status: 'new', origin: null }),
    ).toThrow(SegmentRepoError);
    db.close();
  });
});
