import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { getFile, insertFile, listFiles } from './files.js';
import { openProjectDb } from './index.js';
import { listSegments } from './segments.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';

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

// This fixture is 1250 segments through a full bulk-insert transaction —
// comfortably under 2s locally, but the default 5s vitest timeout has
// been observed to trip on a contended Windows CI runner (13s, same
// commit, while a parallel run of it finished in under 2s). Generous
// headroom rather than a tight bound: nothing here is expected to
// actually take this long.
const BULK_INSERT_TIMEOUT_MS = 30_000;

describe('insertFile / getFile / listFiles', () => {
  it(
    'persists a real DOCX and every segment it assembles into, atomically',
    () => {
      const db = openProjectDb(dbPath());
      const bytes = loadDocx('footnotes-manuscript.docx');
      const assembled = assembleFile(bytes, rulesFor('es'));

      const file = insertFile(db, 'manuscript.docx', assembled, { actor: TEST_ACTOR });
      expect(file.id).toBeGreaterThan(0);
      expect(file.relPath).toBe('manuscript.docx');
      expect(file.originalBlob).toEqual(bytes);
      expect(file.skeleton).toHaveLength(assembled.skeleton.length);
      expect(file.partMap).toEqual(assembled.partMap);

      const stored = listSegments(db, file.id);
      expect(stored).toHaveLength(assembled.segments.length);
      // Round-tripped through JSON, so compare structurally, not by identity.
      expect(stored.map((s) => s.sourceHash)).toEqual(
        assembled.segments.map((s) => s.sourceHash),
      );
      db.close();
    },
    BULK_INSERT_TIMEOUT_MS,
  );

  it('getFile and listFiles agree with what was inserted', () => {
    const db = openProjectDb(dbPath());
    const assembled = assembleFile(loadDocx('prose-short.docx'), rulesFor('en'));
    const file = insertFile(db, 'prose-short.docx', assembled, { actor: TEST_ACTOR });

    expect(getFile(db, file.id)).toEqual(file);
    expect(getFile(db, 999_999)).toBeNull();
    expect(listFiles(db)).toEqual([file]);
    db.close();
  });

  it('inserting a second file does not disturb the first', () => {
    const db = openProjectDb(dbPath());
    const a = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const b = insertFile(
      db,
      'b.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    expect(
      listFiles(db)
        .map((f) => f.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(listSegments(db, a.id).every((s) => s.fileId === a.id)).toBe(true);
    expect(listSegments(db, b.id).every((s) => s.fileId === b.id)).toBe(true);
    db.close();
  });

  it("rejects a second file at the same rel_path (the schema's own UNIQUE)", () => {
    const db = openProjectDb(dbPath());
    const assembled = assembleFile(loadDocx('prose-short.docx'), rulesFor('en'));
    insertFile(db, 'same.docx', assembled, { actor: TEST_ACTOR });
    expect(() => insertFile(db, 'same.docx', assembled, { actor: TEST_ACTOR })).toThrow();
    db.close();
  });
});
