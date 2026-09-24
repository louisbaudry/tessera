import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTm } from '../tm/index.js';
import { retrievePair } from '../tm/retrieve.js';
import { confirmSegment, ConfirmError } from './confirm.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { getSegment, listSegments, setSegmentTarget } from './segments.js';
import { addTmRef, tmAlias } from './tm-refs.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const loadDocx = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-confirm-'));
  return join(dir, 'project.catdb');
};
const ctmPath = (name: string) => join(dir, name);

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A segment with no tags at all — keeps the write-back assertions simple. */
function findPlainSegment(db: Database.Database, fileId: number) {
  const found = listSegments(db, fileId).find(
    (s) => !s.locked && s.sourceTokens.every((t) => t.t === 'text'),
  );
  if (!found) throw new Error('fixture has no eligible plain-text-only segment');
  return found;
}

/** Sets up a project with one file and a write-target TM, returns both. */
function setUpProject() {
  const db = openProjectDb(dbPath());
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  const file = insertFile(
    db,
    'a.docx',
    assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
    { actor: TEST_ACTOR },
  );
  createTm(ctmPath('write-target.ctm'), {
    name: 'write-target',
    generator: 'test',
  }).close();
  const ref = addTmRef(db, {
    path: ctmPath('write-target.ctm'),
    priority: 1,
    isWriteTarget: true,
  });
  return { db, file, ref };
}

describe('confirmSegment', () => {
  it('upserts source and target into the write-target TM and marks the segment confirmed', () => {
    const { db, file } = setUpProject();
    const segment = findPlainSegment(db, file.id);
    setSegmentTarget(db, segment.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Texto confirmado' }],
      status: 'translated',
      origin: 'tm_exact',
    });

    const result = confirmSegment(db, segment.id, { actor: TEST_ACTOR });
    expect(result.tuId).toBeGreaterThan(0);
    expect(result.sourceHistorized).toBe(false);
    expect(result.targetHistorized).toBe(false);

    const after = getSegment(db, segment.id)!;
    expect(after.status).toBe('confirmed');
    expect(after.origin).toBe('tm_exact'); // untouched — confirm changes status only
    expect(after.targetTokens).toEqual([{ t: 'text', v: 'Texto confirmado' }]);

    const matches = retrievePair(
      db,
      { srcLang: 'en', srcHash: segment.sourceHash, tgtLang: 'es' },
      { schema: tmAlias(1) },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tokens).toEqual([{ t: 'text', v: 'Texto confirmado' }]);
    db.close();
  });

  it('writes the source variant using the exact hash already stored on the segment', () => {
    const { db, file } = setUpProject();
    const segment = findPlainSegment(db, file.id);
    setSegmentTarget(db, segment.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'x' }],
      status: 'translated',
      origin: null,
    });
    confirmSegment(db, segment.id, { actor: TEST_ACTOR });

    const alias = tmAlias(1);
    const row = db.prepare(`SELECT hash FROM ${alias}.tuv WHERE lang = 'en'`).get() as {
      hash: string;
    };
    expect(row.hash).toBe(segment.sourceHash);
    db.close();
  });

  it('captures source-side context from sibling segments', () => {
    const { db, file } = setUpProject();
    const plain = listSegments(db, file.id).filter(
      (s) => !s.locked && s.sourceTokens.every((t) => t.t === 'text'),
    );
    expect(plain.length).toBeGreaterThanOrEqual(2);
    const [first, second] = plain;
    setSegmentTarget(db, first!.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'uno' }],
      status: 'translated',
      origin: null,
    });
    setSegmentTarget(db, second!.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'dos' }],
      status: 'translated',
      origin: null,
    });

    confirmSegment(db, second!.id, { actor: TEST_ACTOR });
    const alias = tmAlias(1);
    const row = db
      .prepare(`SELECT prev_hash FROM ${alias}.tuv WHERE lang = 'en'`)
      .get() as { prev_hash: string | null };
    expect(row.prev_hash).toBe(first!.sourceHash);
    db.close();
  });

  it('captures confirmed-target context only from already-confirmed siblings, not draft ones', () => {
    const { db, file } = setUpProject();
    const plain = listSegments(db, file.id).filter(
      (s) => !s.locked && s.sourceTokens.every((t) => t.t === 'text'),
    );
    const [first, second] = plain;
    setSegmentTarget(db, first!.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'uno' }],
      status: 'translated', // not yet confirmed
      origin: null,
    });
    setSegmentTarget(db, second!.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'dos' }],
      status: 'translated',
      origin: null,
    });

    confirmSegment(db, second!.id, { actor: TEST_ACTOR });
    const alias = tmAlias(1);
    const row = db
      .prepare(`SELECT prev_hash FROM ${alias}.tuv WHERE lang = 'es'`)
      .get() as { prev_hash: string | null };
    // "first" was never confirmed, so it is not part of the target chain yet.
    expect(row.prev_hash).toBeNull();

    confirmSegment(db, first!.id, { actor: TEST_ACTOR });
    const rowSecond = db
      .prepare(`SELECT prev_hash FROM ${alias}.tuv WHERE lang = 'es'`)
      .get() as { prev_hash: string | null };
    // Confirming "first" afterwards does not retroactively patch "second"'s
    // already-written context (documented limitation).
    expect(rowSecond.prev_hash).toBeNull();
    db.close();
  });

  it('throws when the segment has no target to confirm', () => {
    const { db, file } = setUpProject();
    const segment = findPlainSegment(db, file.id);
    expect(() => confirmSegment(db, segment.id, { actor: TEST_ACTOR })).toThrow(
      ConfirmError,
    );
    db.close();
  });

  it('throws when the segment is locked', () => {
    const { db, file } = setUpProject();
    const locked = listSegments(db, file.id).find((s) => s.locked)!;
    expect(locked).toBeDefined();
    expect(() => confirmSegment(db, locked.id, { actor: TEST_ACTOR })).toThrow(
      ConfirmError,
    );
    db.close();
  });

  it('throws when no write-target TM is configured', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    const file = insertFile(
      db,
      'a.docx',
      assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const segment = findPlainSegment(db, file.id);
    setSegmentTarget(db, segment.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'x' }],
      status: 'translated',
      origin: null,
    });
    expect(() => confirmSegment(db, segment.id, { actor: TEST_ACTOR })).toThrow(
      ConfirmError,
    );
    db.close();
  });

  it('throws when the project has no identity row', () => {
    const db = openProjectDb(dbPath());
    expect(() => confirmSegment(db, 1, { actor: TEST_ACTOR })).toThrow(ConfirmError);
    db.close();
  });

  it('throws when the segment does not exist', () => {
    const { db } = setUpProject();
    expect(() => confirmSegment(db, 999_999, { actor: TEST_ACTOR })).toThrow(
      ConfirmError,
    );
    db.close();
  });

  it('re-confirming with a differently-tagged target preserves the old value in tuv_history', () => {
    const { db, file } = setUpProject();
    const segment = findPlainSegment(db, file.id);
    setSegmentTarget(db, segment.id, {
      actor: TEST_ACTOR,
      targetTokens: [
        { t: 'open', id: 1, fmt: 1 },
        { t: 'text', v: 'x' },
        { t: 'close', id: 1 },
      ],
      status: 'translated',
      origin: null,
    });
    confirmSegment(db, segment.id, { actor: TEST_ACTOR });

    setSegmentTarget(db, segment.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'x' }], // tags dropped entirely
      status: 'translated',
      origin: null,
    });
    const second = confirmSegment(db, segment.id, { actor: TEST_ACTOR });
    expect(second.targetHistorized).toBe(true);

    const alias = tmAlias(1);
    const history = db.prepare(`SELECT COUNT(*) AS n FROM ${alias}.tuv_history`).get();
    expect(history).toEqual({ n: 1 });
    db.close();
  });

  it('is idempotent: re-confirming the same segment again does not error', () => {
    const { db, file } = setUpProject();
    const segment = findPlainSegment(db, file.id);
    setSegmentTarget(db, segment.id, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'x' }],
      status: 'translated',
      origin: null,
    });
    confirmSegment(db, segment.id, { actor: TEST_ACTOR });
    expect(() => confirmSegment(db, segment.id, { actor: TEST_ACTOR })).not.toThrow();
    db.close();
  });
});
