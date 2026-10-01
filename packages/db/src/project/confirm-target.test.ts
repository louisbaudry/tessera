import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import { createTm } from '../tm/index.js';
import { ConfirmError } from './confirm.js';
import { confirmEditedSegment } from './confirm-target.js';
import { TargetConflictError } from './edit-target.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { getSegment, listSegments, setSegmentTarget } from './segments.js';
import { addTmRef } from './tm-refs.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setUp(options: { writeTarget: boolean }) {
  dir = mkdtempSync(join(tmpdir(), 'cat-confirm-target-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  const file = insertFile(
    db,
    'a.docx',
    assembleFile(
      new Uint8Array(readFileSync(join(FIXTURES, 'form-minimal.docx'))),
      rulesFor('en'),
    ),
    { actor: TEST_ACTOR },
  );
  if (options.writeTarget) {
    createTm(join(dir, 'w.ctm'), { name: 'w', generator: 'test' }).close();
    addTmRef(db, {
      actor: TEST_ACTOR,
      path: join(dir, 'w.ctm'),
      priority: 1,
      isWriteTarget: true,
    });
  }
  const segment = listSegments(db, file.id).find((s) => !s.locked)!;
  setSegmentTarget(db, segment.id, {
    targetTokens: [{ t: 'text', v: 'Texto' }],
    status: 'translated',
    origin: null,
    actor: TEST_ACTOR,
  });
  return { db, id: segment.id };
}

const events = (db: ReturnType<typeof openProjectDb>, id: number) =>
  listEvents(db, { subjectType: 'segment', subjectId: String(id) }).map((e) => e.action);

describe('confirmEditedSegment', () => {
  it('confirms, writes the memory once and reruns QA', () => {
    const { db, id } = setUp({ writeTarget: true });
    const seen = getSegment(db, id)!;
    const result = confirmEditedSegment(db, id, {
      actor: TEST_ACTOR,
      baseUpdatedAt: seen.updatedAt,
    });
    expect(result.changed).toBe(true);
    expect(result.segment.status).toBe('confirmed');
    expect(result.rerun[0]).toBe(id);
    db.close();
  });

  it('is no confirm when the segment is already confirmed: nothing written', () => {
    const { db, id } = setUp({ writeTarget: true });
    confirmEditedSegment(db, id, { actor: TEST_ACTOR });
    const before = getSegment(db, id)!;
    const log = events(db, id);
    const again = confirmEditedSegment(db, id, {
      actor: TEST_ACTOR,
      baseUpdatedAt: before.updatedAt,
    });
    expect(again).toEqual({ segment: before, changed: false, rerun: [], issues: [] });
    expect(events(db, id)).toEqual(log);
    db.close();
  });

  it('refuses a version the editor did not see, and writes nothing', () => {
    const { db, id } = setUp({ writeTarget: true });
    const before = getSegment(db, id)!;
    expect(() =>
      confirmEditedSegment(db, id, {
        actor: TEST_ACTOR,
        baseUpdatedAt: '1999-01-01T00:00:00.000Z',
      }),
    ).toThrow(TargetConflictError);
    expect(getSegment(db, id)).toEqual(before);
    db.close();
  });

  it('says so when the project has no write-target memory, leaving the segment as it was', () => {
    const { db, id } = setUp({ writeTarget: false });
    const before = getSegment(db, id)!;
    expect(() => confirmEditedSegment(db, id, { actor: TEST_ACTOR })).toThrow(
      ConfirmError,
    );
    expect(getSegment(db, id)).toEqual(before);
    db.close();
  });
});
