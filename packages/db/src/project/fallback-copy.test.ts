/**
 * `segment.fallback_copy` (backlog #34, v1-spec.md §3.6): recorded at
 * insert, carried by a split, and backfilled for files already stored.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  countDocxWords,
  plainText,
  rulesFor,
  segmentWords,
} from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { openAndMigrate } from '../migrate.js';
import { insertFile } from './files.js';
import { insertFileBeforeV10 } from './legacy-file.fixture.js';
import { openProjectDb } from './index.js';
import { splitSegmentAt } from './restructure.js';
import { PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './schema.js';
import { listSegments } from './segments.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const BOXED = 'rich-mixed-content.docx';

let dir: string;
const tempPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-fallback-copy-'));
  return join(dir, 'project.catdb');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const flags = (db: ReturnType<typeof openProjectDb>, fileId: number) =>
  listSegments(db, fileId).map((s) => s.fallbackCopy);

describe('segment.fallback_copy', () => {
  it("is stored as assembled, so the file's words are the upload's count", () => {
    const db = openProjectDb(tempPath());
    const bytes = load(BOXED);
    const assembled = assembleFile(bytes, rulesFor('en'));
    const file = insertFile(db, 'a.docx', assembled, { actor: TEST_ACTOR });
    const stored = listSegments(db, file.id);
    expect(stored.map((s) => s.fallbackCopy)).toEqual(
      assembled.segments.map((s) => s.fallbackCopy),
    );
    expect(stored.some((s) => s.fallbackCopy)).toBe(true);
    expect(stored.reduce((n, s) => n + segmentWords(s), 0)).toBe(
      countDocxWords(bytes, 'en'),
    );
    db.close();
  });

  it('is carried to both halves of a split', () => {
    const db = openProjectDb(tempPath());
    const file = insertFile(db, 'a.docx', assembleFile(load(BOXED), rulesFor('en')), {
      actor: TEST_ACTOR,
    });
    const copy = listSegments(db, file.id).find((s) => {
      const text = plainText(s.sourceTokens);
      return s.fallbackCopy && !s.locked && text.indexOf(' ', 3) > 3;
    });
    expect(copy).toBeDefined();
    const at = plainText(copy!.sourceTokens).indexOf(' ', 3) + 1;
    const { segments } = splitSegmentAt(db, copy!.id, { offset: at, actor: TEST_ACTOR });
    expect(segments.map((s) => s.fallbackCopy)).toEqual([true, true]);
    db.close();
  });

  it('is backfilled from the stored skeleton when a v9 project opens', () => {
    const path = tempPath();
    const assembled = assembleFile(load(BOXED), rulesFor('en'));
    const old = openAndMigrate(path, {
      applicationId: PROJECT_APPLICATION_ID,
      migrations: PROJECT_MIGRATIONS.slice(0, 9),
    });
    const fileId = insertFileBeforeV10(old, 'a.docx', assembled, TEST_ACTOR);
    old.close();

    const db = openProjectDb(path);
    expect(flags(db, fileId)).toEqual(assembled.segments.map((s) => s.fallbackCopy));
    db.close();
  });
});
