import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  normalizeTokens,
  plainText,
  readDocx,
  rulesFor,
  SegmentEditError,
  type Segment,
  type Token,
} from '@cat-tool/core';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import { TargetConflictError } from './edit-target.js';
import { exportFile } from './export.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { addQaIssue, listQaIssues } from './qa-issues.js';
import { mergeSegmentWithNext, splitSegmentAt } from './restructure.js';
import { PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './schema.js';
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
const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const partDigests = (bytes: Uint8Array): Map<string, string> =>
  new Map(readDocx(bytes).parts.map((p) => [p.name, digest(p.data)]));

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function project(name: string) {
  dir = mkdtempSync(join(tmpdir(), 'cat-restructure-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  const bytes = loadDocx(name);
  const file = insertFile(db, name, assembleFile(bytes, rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  return { db, file, bytes };
}

/** A paragraph's segments in `para_ord` order, from the first with a sibling after it. */
function pairIn(db: Database.Database, fileId: number): [Segment, Segment] {
  const all = listSegments(db, fileId);
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i]!;
    const b = all[i + 1]!;
    if (
      !a.locked &&
      !b.locked &&
      a.part === b.part &&
      a.paraKey === b.paraKey &&
      b.paraOrd === a.paraOrd + 1
    ) {
      return [a, b];
    }
  }
  throw new Error('no two adjacent segments of one paragraph in this fixture');
}

/** A segment with room to be split: the offset of a space inside its text. */
function splittable(db: Database.Database, fileId: number): { seg: Segment; at: number } {
  for (const seg of listSegments(db, fileId)) {
    if (seg.locked) continue;
    const text = plainText(seg.sourceTokens);
    const at = text.indexOf(' ', 3) + 1;
    if (at > 3 && at < text.trim().length - 2) return { seg, at };
  }
  throw new Error('nothing to split in this fixture');
}

/** Every file's `ord`s run 0..n-1 and each paragraph's `para_ord`s run 0..k-1. */
function expectOrdered(db: Database.Database, fileId: number): void {
  const all = listSegments(db, fileId);
  expect(all.map((s) => s.ord)).toEqual(all.map((_, i) => i));
  const byPara = new Map<string, number[]>();
  for (const s of all) {
    const key = `${s.part}\u0000${s.paraKey}`;
    byPara.set(key, [...(byPara.get(key) ?? []), s.paraOrd]);
  }
  for (const orders of byPara.values()) {
    expect([...orders].sort((x, y) => x - y)).toEqual(orders.map((_, i) => i));
  }
}

const text = (v: string): Token => ({ t: 'text', v });

describe('splitSegmentAt', () => {
  it('cuts one row into two: ids, order, hashes, and the audit event', () => {
    const { db, file } = project('prose-short.docx');
    const before = listSegments(db, file.id);
    const { seg, at } = splittable(db, file.id);
    const later = before.filter((s) => s.ord > seg.ord).map((s) => s.id);

    const result = splitSegmentAt(db, seg.id, { offset: at, actor: TEST_ACTOR });
    const [first, second] = result.segments;
    expect(first!.id).toBe(seg.id); // the first half keeps the row
    expect(second!.id).not.toBe(seg.id);
    expect(result.removed).toEqual([]);
    expect(first!.ord).toBe(seg.ord);
    expect(second!.ord).toBe(seg.ord + 1);
    expect(second!.paraOrd).toBe(seg.paraOrd + 1);
    expect(second!.paraKey).toBe(seg.paraKey);
    expect(plainText(first!.sourceTokens) + plainText(second!.sourceTokens)).toBe(
      plainText(seg.sourceTokens),
    );
    expect(first!.sourceHash).toBe(normalizeTokens(first!.sourceTokens).hash);
    expect(second!.sourceHash).toBe(normalizeTokens(second!.sourceTokens).hash);
    expect(second!.status).toBe('new');
    expect(second!.targetTokens).toBeNull();
    // Everything after moved by exactly one place.
    const after = listSegments(db, file.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((s) => s.ord > seg.ord + 1).map((s) => s.id)).toEqual(later);
    expectOrdered(db, file.id);

    const events = listEvents(db, { subjectType: 'segment', subjectId: String(seg.id) });
    const split = events.find((e) => e.action === 'segment.split')!;
    expect(JSON.parse(split.detail!)).toMatchObject({
      new_segment_id: second!.id,
      offset: at,
    });
    expect(split.actor).toBe('cli:test');
    expect(verifyAudit(db)).toEqual({ events: expect.any(Number), brokenAt: null });
    db.close();
  });

  it('leaves the whole target on the first half, as a draft with no origin', () => {
    const { db, file } = project('prose-short.docx');
    const { seg, at } = splittable(db, file.id);
    setSegmentTarget(db, seg.id, {
      targetTokens: [text('Una traducción completa.')],
      status: 'confirmed',
      origin: 'tm_exact',
      actor: TEST_ACTOR,
    });
    const [first, second] = splitSegmentAt(db, seg.id, {
      offset: at,
      actor: TEST_ACTOR,
    }).segments;
    expect(first!.status).toBe('draft');
    expect(first!.origin).toBeNull();
    expect(plainText(first!.targetTokens!)).toBe('Una traducción completa.');
    expect(second!.targetTokens).toBeNull();
    const detail = listEvents(db, { subjectType: 'segment', subjectId: String(seg.id) })
      .filter((e) => e.action === 'segment.split')
      .map(
        (e) =>
          JSON.parse(e.detail!) as {
            first: { status: string };
            second: { status: string };
          },
      );
    expect(detail[0]!.first.status).toBe('draft');
    expect(detail[0]!.second.status).toBe('new');
    db.close();
  });

  it('refuses a locked segment, a stale version and an offset outside the source', () => {
    const { db, file } = project('prose-short.docx');
    const { seg, at } = splittable(db, file.id);
    expect(() =>
      splitSegmentAt(db, seg.id, {
        offset: at,
        actor: TEST_ACTOR,
        baseUpdatedAt: '1999-01-01T00:00:00.000Z',
      }),
    ).toThrow(TargetConflictError);
    expect(() => splitSegmentAt(db, seg.id, { offset: 0, actor: TEST_ACTOR })).toThrow(
      SegmentEditError,
    );
    expect(() =>
      splitSegmentAt(db, seg.id, { offset: 10_000, actor: TEST_ACTOR }),
    ).toThrow(SegmentEditError);
    db.prepare('UPDATE segment SET locked = 1 WHERE id = ?').run(seg.id);
    expect(() => splitSegmentAt(db, seg.id, { offset: at, actor: TEST_ACTOR })).toThrow(
      SegmentRepoError,
    );
    expect(() => splitSegmentAt(db, 9_999, { offset: at, actor: TEST_ACTOR })).toThrow(
      /no segment/,
    );
    // Nothing was written by any refusal.
    expect(
      listEvents(db, { subjectType: 'segment' }).some(
        (e) => e.action === 'segment.split',
      ),
    ).toBe(false);
    db.close();
  });

  it('reruns QA for the segments it made', () => {
    const { db, file } = project('prose-short.docx');
    const { seg, at } = splittable(db, file.id);
    addQaIssue(db, {
      segmentId: seg.id,
      rule: 'tag.missing',
      severity: 'error',
      message: 'x',
    });
    const result = splitSegmentAt(db, seg.id, { offset: at, actor: TEST_ACTOR });
    expect(result.rerun.slice(0, 2)).toEqual(result.segments.map((s) => s.id));
    // The stale finding was replaced by a fresh run, which finds nothing to say
    // about a tagless source with no target but the untranslated warning.
    expect(listQaIssues(db, seg.id).some((i) => i.rule === 'tag.missing')).toBe(false);
    db.close();
  });
});

describe('mergeSegmentWithNext', () => {
  it('joins two rows into the first: id, order, hash, the second and its QA gone', () => {
    const { db, file } = project('prose-short.docx');
    const [a, b] = pairIn(db, file.id);
    addQaIssue(db, {
      segmentId: b.id,
      rule: 'seg.empty',
      severity: 'warning',
      message: 'x',
    });
    const count = listSegments(db, file.id).length;

    const result = mergeSegmentWithNext(db, a.id, { actor: TEST_ACTOR });
    expect(result.removed).toEqual([b.id]);
    const [merged] = result.segments;
    expect(merged!.id).toBe(a.id);
    expect(plainText(merged!.sourceTokens)).toBe(
      plainText(a.sourceTokens) + plainText(b.sourceTokens),
    );
    expect(merged!.sourceHash).toBe(normalizeTokens(merged!.sourceTokens).hash);
    expect(getSegment(db, b.id)).toBeNull();
    expect(listQaIssues(db, b.id)).toEqual([]);
    expect(listSegments(db, file.id)).toHaveLength(count - 1);
    expectOrdered(db, file.id);

    const merge = listEvents(db, {
      subjectType: 'segment',
      subjectId: String(a.id),
    }).find((e) => e.action === 'segment.merged')!;
    expect(JSON.parse(merge.detail!)).toMatchObject({ removed_segment_id: b.id });
    // The removed row's history is still in the log, under its old id.
    expect(listEvents(db, { subjectType: 'segment', subjectId: String(b.id) })).toEqual(
      expect.any(Array),
    );
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });

  it('joins two targets with a space, as a draft with no origin', () => {
    const { db, file } = project('prose-short.docx');
    const [a, b] = pairIn(db, file.id);
    for (const [seg, target] of [
      [a, 'Uno.'],
      [b, 'Dos.'],
    ] as const) {
      setSegmentTarget(db, seg.id, {
        targetTokens: [text(target)],
        status: 'confirmed',
        origin: 'tm_exact',
        actor: TEST_ACTOR,
      });
    }
    const [merged] = mergeSegmentWithNext(db, a.id, { actor: TEST_ACTOR }).segments;
    expect(plainText(merged!.targetTokens!)).toBe('Uno. Dos.');
    expect(merged!.status).toBe('draft');
    expect(merged!.origin).toBeNull();
    db.close();
  });

  it('refuses the last segment of a paragraph, a locked one and a stale version', () => {
    const { db, file } = project('prose-short.docx');
    const [a, b] = pairIn(db, file.id);
    const paragraph = listSegments(db, file.id).filter(
      (s) => s.part === b.part && s.paraKey === b.paraKey,
    );
    const last = paragraph[paragraph.length - 1]!;
    expect(() => mergeSegmentWithNext(db, last.id, { actor: TEST_ACTOR })).toThrow(
      /last of its paragraph/,
    );
    expect(() =>
      mergeSegmentWithNext(db, a.id, { actor: TEST_ACTOR, nextBaseUpdatedAt: 'stale' }),
    ).toThrow(TargetConflictError);
    expect(() =>
      mergeSegmentWithNext(db, a.id, { actor: TEST_ACTOR, baseUpdatedAt: 'stale' }),
    ).toThrow(TargetConflictError);
    db.prepare('UPDATE segment SET locked = 1 WHERE id = ?').run(b.id);
    expect(() => mergeSegmentWithNext(db, a.id, { actor: TEST_ACTOR })).toThrow(
      SegmentRepoError,
    );
    expect(
      listEvents(db, { subjectType: 'segment' }).some(
        (e) => e.action === 'segment.merged',
      ),
    ).toBe(false);
    db.close();
  });
});

describe('through the exported DOCX', () => {
  // Each round reruns QA across the project, so a big file is slow on a
  // slow runner: a few rounds per file, and a timeout that says so.
  const ROUNDS = 8;
  const SLOW = 60_000;
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.docx'));

  it.each(fixtures)(
    'a split then a merge of untranslated segments exports the original bytes: %s',
    (name) => {
      const { db, file, bytes } = project(name);
      const before = listSegments(db, file.id);
      let done = 0;
      for (const seg of before) {
        if (seg.locked || done >= ROUNDS) continue;
        const text = plainText(seg.sourceTokens);
        const at = Math.floor(text.length / 2);
        let result;
        try {
          result = splitSegmentAt(db, seg.id, { offset: at, actor: TEST_ACTOR });
        } catch (err) {
          if (err instanceof SegmentEditError) continue; // no room to cut here
          throw err;
        }
        mergeSegmentWithNext(db, result.segments[0]!.id, { actor: TEST_ACTOR });
        done++;
      }
      const after = listSegments(db, file.id);
      expect(after.map((s) => [s.id, s.ord, s.paraOrd, s.sourceHash])).toEqual(
        before.map((s) => [s.id, s.ord, s.paraOrd, s.sourceHash]),
      );
      // Text and hash, not tokens: merging fuses two adjacent runs of one
      // formatting, which the renderer does anyway (`mergeSegments`) — the
      // exported bytes below are the invariant.
      const normal = (s: Segment) => [s.id, plainText(s.sourceTokens), s.sourceHash];
      expect(after.map(normal)).toEqual(before.map(normal));
      expectOrdered(db, file.id);
      const exported = exportFile(db, file.id, { actor: TEST_ACTOR });
      expect(partDigests(exported.bytes)).toEqual(partDigests(bytes));
      expect(verifyAudit(db).brokenAt).toBeNull();
      db.close();
    },
    SLOW,
  );

  it(
    'merging translated segments renders the paragraph as the two did apart',
    () => {
      const { db, file } = project('prose-long.docx');
      // Translate every segment with its own source, then export.
      for (const seg of listSegments(db, file.id)) {
        if (seg.locked) continue;
        setSegmentTarget(db, seg.id, {
          targetTokens: seg.sourceTokens,
          status: 'translated',
          origin: null,
          actor: TEST_ACTOR,
        });
      }
      const apart = partDigests(exportFile(db, file.id, { actor: TEST_ACTOR }).bytes);
      // Then merge every pair of one paragraph into one segment.
      let merged = 0;
      for (const seg of listSegments(db, file.id)) {
        const still = getSegment(db, seg.id);
        if (!still || still.locked) continue;
        try {
          mergeSegmentWithNext(db, seg.id, { actor: TEST_ACTOR });
          merged++;
        } catch (err) {
          if (!(err instanceof SegmentRepoError)) throw err;
        }
      }
      expect(merged).toBeGreaterThan(0);
      expectOrdered(db, file.id);
      const together = partDigests(exportFile(db, file.id, { actor: TEST_ACTOR }).bytes);
      expect(together).toEqual(apart);
      db.close();
    },
    SLOW,
  );
});

describe('migrating a v7 project', () => {
  it('opens at the current version with its log intact, and takes the new actions', () => {
    dir = mkdtempSync(join(tmpdir(), 'cat-restructure-migrate-'));
    const path = join(dir, 'old.catdb');
    const old = openAndMigrate(path, {
      applicationId: PROJECT_APPLICATION_ID,
      migrations: PROJECT_MIGRATIONS.slice(0, 7),
    });
    createProject(old, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    insertFile(
      old,
      'a.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
      {
        actor: TEST_ACTOR,
      },
    );
    old.close();

    const db = openProjectDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_MIGRATIONS.length);
    expect(verifyAudit(db)).toEqual({ events: 1, brokenAt: null });
    const { seg, at } = splittable(db, 1);
    splitSegmentAt(db, seg.id, { offset: at, actor: TEST_ACTOR });
    expect(verifyAudit(db)).toEqual({ events: 2, brokenAt: null });
    // Still append-only after the rebuild.
    expect(() => db.prepare('DELETE FROM audit_event').run()).toThrow(/append-only/);
    db.close();
    new Database(path, { readonly: true }).close();
  });
});
