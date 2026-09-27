import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  carryHiddenTags,
  rulesFor,
  withoutHiddenTags,
  type Segment,
  type Token,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import {
  editSegmentTarget,
  TargetConflictError,
  TargetStructureError,
} from './edit-target.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { addQaIssue, listQaIssues } from './qa-issues.js';
import {
  getSegment,
  listSegments,
  SegmentRepoError,
  setSegmentTarget,
} from './segments.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const loadDocx = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function project(...names: string[]): Database.Database {
  dir = mkdtempSync(join(tmpdir(), 'cat-edit-target-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  names.forEach((name, i) =>
    insertFile(db, `${i}-${name}`, assembleFile(loadDocx(name), rulesFor('en')), {
      actor: TEST_ACTOR,
    }),
  );
  return db;
}

const text = (v: string): Token => ({ t: 'text', v });
/** The first unlocked segment that carries hidden tags and nothing visible. */
const hiddenOnly = (db: Database.Database): Segment =>
  listSegments(db, 1).find(
    (s) =>
      !s.locked && s.formatTable.length > 0 && s.formatTable.every((f) => !f.visible),
  )!;
const history = (db: Database.Database, id: number) =>
  listEvents(db, { subjectType: 'segment', subjectId: String(id) });

describe('editSegmentTarget', () => {
  it("stores the translator's target with its hidden tags carried: translated, no origin", () => {
    const db = project('form-minimal.docx');
    const segment = hiddenOnly(db);
    const result = editSegmentTarget(db, segment.id, {
      tokens: [text('Hola')],
      actor: TEST_ACTOR,
    });
    expect(result.changed).toBe(true);
    expect(result.segment).toMatchObject({ status: 'translated', origin: null });
    expect(result.segment.targetTokens).toEqual(
      carryHiddenTags([text('Hola')], segment.sourceTokens, segment.formatTable),
    );
    expect(history(db, segment.id).map((e) => e.action)).toEqual(['segment.target_set']);
    db.close();
  });

  it('writes nothing when nothing visible changed: a TM match keeps its origin', () => {
    const db = project('form-minimal.docx');
    const segment = hiddenOnly(db);
    // A TM match whose hidden tags sit where another document had them.
    setSegmentTarget(db, segment.id, {
      targetTokens: [text('Hola '), text('mundo')],
      status: 'translated',
      origin: 'tm_exact',
      actor: TEST_ACTOR,
    });
    const before = getSegment(db, segment.id)!;
    const result = editSegmentTarget(db, segment.id, {
      tokens: [text('Hola mundo')],
      actor: TEST_ACTOR,
    });
    expect(result).toEqual({ segment: before, changed: false, rerun: [], issues: [] });
    expect(history(db, segment.id)).toHaveLength(1);
    db.close();
  });

  it('makes an emptied target untranslated, never an empty translation', () => {
    const db = project('form-minimal.docx');
    const segment = hiddenOnly(db);
    editSegmentTarget(db, segment.id, { tokens: [text('Hola')], actor: TEST_ACTOR });
    const result = editSegmentTarget(db, segment.id, { tokens: [], actor: TEST_ACTOR });
    expect(result.segment).toMatchObject({
      targetTokens: null,
      status: 'new',
      origin: null,
    });
    // And an untranslated segment left empty is no edit at all.
    expect(
      editSegmentTarget(db, segment.id, { tokens: [text('')], actor: TEST_ACTOR })
        .changed,
    ).toBe(false);
    db.close();
  });

  it('unconfirms a confirmed segment it changes, and leaves one it does not', () => {
    const db = project('form-minimal.docx');
    const segment = hiddenOnly(db);
    setSegmentTarget(db, segment.id, {
      targetTokens: [text('Hola')],
      status: 'confirmed',
      origin: null,
      actor: TEST_ACTOR,
    });
    const same = editSegmentTarget(db, segment.id, {
      tokens: [text('Hola')],
      actor: TEST_ACTOR,
    });
    expect(same.changed).toBe(false);
    expect(same.segment.status).toBe('confirmed');
    const edited = editSegmentTarget(db, segment.id, {
      tokens: [text('Hola, mundo')],
      actor: TEST_ACTOR,
    });
    expect(edited.segment.status).toBe('translated');
    db.close();
  });

  it('refuses a write over a newer version, and takes one over the version it saw', () => {
    const db = project('form-minimal.docx');
    const segment = hiddenOnly(db);
    const first = editSegmentTarget(db, segment.id, {
      tokens: [text('Uno')],
      actor: TEST_ACTOR,
      baseUpdatedAt: segment.updatedAt,
    });
    // A second tab, still holding the segment as it was before.
    expect(() =>
      editSegmentTarget(db, segment.id, {
        tokens: [text('Dos')],
        actor: TEST_ACTOR,
        baseUpdatedAt: segment.updatedAt,
      }),
    ).toThrow(TargetConflictError);
    expect(getSegment(db, segment.id)!.targetTokens).toEqual(first.segment.targetTokens);
    expect(
      editSegmentTarget(db, segment.id, {
        tokens: [text('Dos')],
        actor: TEST_ACTOR,
        baseUpdatedAt: first.segment.updatedAt,
      }).changed,
    ).toBe(true);
    db.close();
  });

  it('refuses tags that do not nest, which export could not render', () => {
    const db = project('form-release.docx');
    const segment = listSegments(db, 1).find(
      (s) => !s.locked && s.formatTable.some((f) => f.visible && f.placement === 'run'),
    )!;
    const run = segment.formatTable.find((f) => f.visible && f.placement === 'run')!;
    expect(() =>
      editSegmentTarget(db, segment.id, {
        tokens: [
          { t: 'close', id: run.id },
          text('x'),
          { t: 'open', id: run.id, fmt: run.id },
        ],
        actor: TEST_ACTOR,
      }),
    ).toThrow(TargetStructureError);
    db.close();
  });

  it('refuses a locked segment', () => {
    const db = project('form-minimal.docx');
    const locked = listSegments(db, 1).find((s) => s.locked)!;
    expect(() =>
      editSegmentTarget(db, locked.id, { tokens: [text('x')], actor: TEST_ACTOR }),
    ).toThrow(SegmentRepoError);
    db.close();
  });

  it('reruns QA for the segment and every segment sharing its source', () => {
    // The same document twice: every segment has a twin with its source.
    const db = project('form-minimal.docx', 'form-minimal.docx');
    const segment = hiddenOnly(db);
    const twin = listSegments(db, 2).find((s) => s.sourceHash === segment.sourceHash)!;
    editSegmentTarget(db, twin.id, { tokens: [text('Una versión')], actor: TEST_ACTOR });
    // A stale warning the edit should clear: pre-translate's, say.
    addQaIssue(db, {
      segmentId: segment.id,
      rule: 'tag.missing',
      severity: 'warning',
      message: 'stale',
    });

    const result = editSegmentTarget(db, segment.id, {
      tokens: [text('Otra versión')],
      actor: TEST_ACTOR,
    });
    expect(listQaIssues(db, segment.id).map((i) => i.rule)).not.toContain('tag.missing');
    const twinRules = listQaIssues(db, twin.id).map((i) => i.rule);
    expect(twinRules).toContain('consistency.target_differs');
    // What was rerun comes back, for the grid to replace.
    expect(result.rerun).toEqual([segment.id, twin.id]);
    expect(result.issues.map((i) => i.segmentId)).toContain(twin.id);
    expect(withoutHiddenTags(result.segment.targetTokens!, segment.formatTable)).toEqual([
      text('Otra versión'),
    ]);
    db.close();
  });
});
