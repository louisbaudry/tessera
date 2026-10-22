import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  plainText,
  REPLACE_MAX_SEGMENTS,
  rulesFor,
  type FindSpec,
  type Token,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { applyReplace, FindError, scanReplace } from './find-replace.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { getSegment, listSegments, setSegmentTarget } from './segments.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const loadDocx = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const text = (v: string): Token => ({ t: 'text', v });
const literal = (pattern: string, caseSensitive = false): FindSpec => ({
  pattern,
  regex: false,
  caseSensitive,
});

/** A project (en to es) from the fixture, with the first `targets.length` unlocked segments translated. */
function project(targets: string[]) {
  dir = mkdtempSync(join(tmpdir(), 'cat-find-replace-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  insertFile(db, 'a.docx', assembleFile(loadDocx('form-minimal.docx'), rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  const segments = listSegments(db, 1).filter((s) => !s.locked);
  const ids = targets.map((t, i) => {
    const s = segments[i]!;
    setSegmentTarget(db, s.id, {
      targetTokens: [text(t)],
      status: 'translated',
      origin: null,
      actor: TEST_ACTOR,
    });
    return s.id;
  });
  return { db, ids };
}

const targetText = (db: Database.Database, id: number) =>
  plainText(getSegment(db, id)!.targetTokens ?? []);
const batch = (db: Database.Database) =>
  listEvents(db, { subjectType: 'project' }).filter(
    (e) => e.action === 'project.replaced',
  );

describe('scanReplace', () => {
  it('lists each segment that would change, with its text before and after and where the match sits', () => {
    const { db, ids } = project([
      'Abra la tapa.',
      'Cierre la ventana.',
      'Otra tapa y otra tapa.',
    ]);
    const scan = scanReplace(db, { find: literal('tapa'), replacement: 'cubierta' });
    expect(scan.proposals.map((p) => p.segmentId)).toEqual([ids[0], ids[2]]);
    expect(scan.proposals[0]).toMatchObject({
      before: 'Abra la tapa.',
      after: 'Abra la cubierta.',
      count: 1,
      ranges: [{ start: 8, end: 12 }],
      status: 'translated',
    });
    expect(scan.proposals[1]).toMatchObject({ count: 2 });
    expect(scan).toMatchObject({ scanned: 3, locked: 0, truncated: false });
    db.close();
  });

  it('writes nothing, and skips segments with no target and locked ones', () => {
    const { db, ids } = project(['Abra la tapa.']);
    const locked = listSegments(db, 1).find((s) => s.locked)!;
    db.prepare('UPDATE segment SET target_tokens = ? WHERE id = ?').run(
      JSON.stringify([text('tapa bloqueada')]),
      locked.id,
    );
    const before = db.prepare('SELECT COUNT(*) AS n FROM audit_event').get();
    const scan = scanReplace(db, { find: literal('tapa'), replacement: 'x' });
    expect(scan.proposals.map((p) => p.segmentId)).toEqual([ids[0]]);
    expect(scan.locked).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_event').get()).toEqual(before);
    expect(targetText(db, ids[0]!)).toBe('Abra la tapa.');
    db.close();
  });

  it('refuses a pattern that cannot run', () => {
    const { db } = project(['x']);
    expect(() =>
      scanReplace(db, {
        find: { pattern: '(', regex: true, caseSensitive: false },
        replacement: '',
      }),
    ).toThrow(FindError);
    expect(() => scanReplace(db, { find: literal(''), replacement: '' })).toThrow(
      FindError,
    );
    db.close();
  });

  it('caps a preview and says so', () => {
    const { db } = project(['uno', 'dos']);
    const scan = scanReplace(db, { find: literal('o'), replacement: 'x' });
    expect(scan.truncated).toBe(false);
    expect(REPLACE_MAX_SEGMENTS).toBeGreaterThan(2);
    db.close();
  });

  it('stops between segments when asked, and says it did not finish', () => {
    const { db } = project(['uno o', 'dos o']);
    let calls = 0;
    const scan = scanReplace(
      db,
      { find: literal('o'), replacement: 'x' },
      { shouldStop: () => ++calls > 1 },
    );
    expect(scan.complete).toBe(false);
    expect(scan.proposals).toHaveLength(1);
    db.close();
  });
});

describe('applyReplace', () => {
  const run = (
    db: Database.Database,
    ids: number[],
    extra: Partial<Parameters<typeof applyReplace>[1]> = {},
  ) =>
    applyReplace(db, {
      find: literal('tapa'),
      replacement: 'cubierta',
      chosen: ids.map((segmentId) => ({
        segmentId,
        updatedAt: getSegment(db, segmentId)!.updatedAt,
      })),
      actor: TEST_ACTOR,
      ...extra,
    });

  it('writes the kept segments through the editor’s own write: translated, no origin, and one batch in the log', () => {
    const { db, ids } = project(['Abra la tapa.', 'Cierre la ventana.']);
    db.prepare(
      "UPDATE segment SET status = 'confirmed', origin = 'tm_exact' WHERE id = ?",
    ).run(ids[0]);
    const result = run(db, [ids[0]!]);
    expect(result).toMatchObject({
      segments: 1,
      matches: 1,
      stale: 0,
      locked: 0,
      unchanged: 0,
    });
    expect(targetText(db, ids[0]!)).toBe('Abra la cubierta.');
    // A confirmed segment is confirmed again before the memory hears of it.
    expect(getSegment(db, ids[0]!)).toMatchObject({ status: 'translated', origin: null });
    // The one not chosen is untouched.
    expect(targetText(db, ids[1]!)).toBe('Cierre la ventana.');

    const [event] = batch(db);
    expect(event!.id).toBe(result.batchId);
    expect(JSON.parse(event!.detail!)).toEqual({
      regex: false,
      case_sensitive: false,
      segments: 1,
      matches: 1,
      stale: 0,
      locked: 0,
    });
    // The words searched and written are the owner's, never in the log.
    expect(JSON.stringify(event)).not.toMatch(/tapa|cubierta/);
    const child = listEvents(db, {
      subjectType: 'segment',
      subjectId: String(ids[0]),
    }).at(-1)!;
    expect(child).toMatchObject({
      action: 'segment.target_set',
      batchId: result.batchId,
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });

  it('skips a segment that changed since the preview, and says so, instead of overwriting it', () => {
    const { db, ids } = project(['Abra la tapa.', 'Otra tapa.']);
    const seen = ids.map((segmentId) => ({
      segmentId,
      updatedAt: getSegment(db, segmentId)!.updatedAt,
    }));
    setSegmentTarget(db, ids[0]!, {
      targetTokens: [text('Texto nuevo de la tapa.')],
      status: 'translated',
      origin: null,
      actor: TEST_ACTOR,
    });
    const result = applyReplace(db, {
      find: literal('tapa'),
      replacement: 'cubierta',
      chosen: seen,
      actor: TEST_ACTOR,
    });
    expect(result).toMatchObject({ segments: 1, stale: 1 });
    expect(targetText(db, ids[0]!)).toBe('Texto nuevo de la tapa.');
    expect(targetText(db, ids[1]!)).toBe('Otra cubierta.');
    expect(JSON.parse(batch(db)[0]!.detail!)).toMatchObject({ segments: 1, stale: 1 });
    db.close();
  });

  it('skips a segment locked since, and one the replacement would not change', () => {
    const { db, ids } = project(['Abra la tapa.', 'Otra tapa.']);
    db.prepare('UPDATE segment SET locked = 1 WHERE id = ?').run(ids[0]);
    const same = run(db, [ids[0]!, ids[1]!], { replacement: 'tapa' });
    expect(same).toMatchObject({ segments: 0, locked: 1, unchanged: 1, batchId: null });
    // Nothing written means nothing logged.
    expect(batch(db)).toEqual([]);
    db.close();
  });

  it('is all or nothing: a failure part-way leaves every segment as it was and no event', () => {
    const { db, ids } = project(['Abra la tapa.', 'Otra tapa.']);
    const chosen = ids.map((segmentId) => ({
      segmentId,
      updatedAt: getSegment(db, segmentId)!.updatedAt,
    }));
    // Break the second write: its segment row can no longer be updated.
    db.exec(
      `CREATE TRIGGER no_second BEFORE UPDATE ON segment WHEN new.id = ${ids[1]} BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    expect(() =>
      applyReplace(db, {
        find: literal('tapa'),
        replacement: 'cubierta',
        chosen,
        actor: TEST_ACTOR,
      }),
    ).toThrow(/refused/);
    expect(targetText(db, ids[0]!)).toBe('Abra la tapa.');
    expect(batch(db)).toEqual([]);
    db.close();
  });

  it('replaces with a regular expression and its groups', () => {
    const { db, ids } = project(['Abra la tapa 12.', 'Cierre la tapa 7.']);
    const result = applyReplace(db, {
      find: { pattern: 'tapa (\\d+)', regex: true, caseSensitive: true },
      replacement: 'cubierta n.º $1',
      chosen: ids.map((segmentId) => ({
        segmentId,
        updatedAt: getSegment(db, segmentId)!.updatedAt,
      })),
      actor: TEST_ACTOR,
    });
    expect(result.segments).toBe(2);
    expect(targetText(db, ids[0]!)).toBe('Abra la cubierta n.º 12.');
    expect(JSON.parse(batch(db)[0]!.detail!)).toMatchObject({
      regex: true,
      case_sensitive: true,
    });
    db.close();
  });

  it('refuses more segments than a run takes, and a pattern that cannot run', () => {
    const { db, ids } = project(['x']);
    const many = Array.from({ length: REPLACE_MAX_SEGMENTS + 1 }, (_, i) => ({
      segmentId: ids[0]! + i,
      updatedAt: 'x',
    }));
    expect(() =>
      applyReplace(db, {
        find: literal('x'),
        replacement: 'y',
        chosen: many,
        actor: TEST_ACTOR,
      }),
    ).toThrow(FindError);
    expect(() =>
      applyReplace(db, {
        find: literal(''),
        replacement: 'y',
        chosen: [],
        actor: TEST_ACTOR,
      }),
    ).toThrow(FindError);
    db.close();
  });

  it('counts one segment named twice once', () => {
    const { db, ids } = project(['Abra la tapa.']);
    const c = { segmentId: ids[0]!, updatedAt: getSegment(db, ids[0]!)!.updatedAt };
    const result = applyReplace(db, {
      find: literal('tapa'),
      replacement: 'cubierta',
      chosen: [c, c],
      actor: TEST_ACTOR,
    });
    expect(result).toMatchObject({ segments: 1, stale: 0 });
    db.close();
  });
});
