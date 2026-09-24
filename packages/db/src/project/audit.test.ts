/**
 * `audit_event` in `project.catdb` (audit-spec.md §2, §6, §7; backlog #56):
 * the table refuses to be rewritten, every write path leaves the event
 * the spec names, and the chain catches a raw-SQL edit.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor, type AuditDetail, type Token } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listBatch, listEvents, verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import { createTm } from '../tm/index.js';
import { confirmSegment } from './confirm.js';
import { exportFile } from './export.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { pretranslate } from './pretranslate.js';
import { createProject } from './project.js';
import { PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './schema.js';
import { listSegments, setSegmentTarget } from './segments.js';
import { addTmRef, tmAlias } from './tm-refs.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const DOCX = new Uint8Array(readFileSync(join(FIXTURES, 'form-minimal.docx')));
const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function newProject(): { db: Database.Database; path: string } {
  dir = mkdtempSync(join(tmpdir(), 'cat-audit-'));
  const path = join(dir, 'project.catdb');
  const db = openProjectDb(path);
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  return { db, path };
}

function addFile(db: Database.Database, relPath = 'a.docx') {
  return insertFile(db, relPath, assembleFile(DOCX, rulesFor('en')), {
    actor: TEST_ACTOR,
  });
}

function plainSegment(db: Database.Database, fileId: number) {
  const found = listSegments(db, fileId).find(
    (s) => !s.locked && s.sourceTokens.every((t) => t.t === 'text'),
  );
  if (!found) throw new Error('fixture has no plain-text-only segment');
  return found;
}

const text = (v: string): Token[] => [{ t: 'text', v }];
const detailOf = <A extends keyof AuditDetail>(detail: string | null) =>
  JSON.parse(detail!) as AuditDetail[A];

describe('audit_event is append-only', () => {
  it('aborts a DELETE and an UPDATE, but lets a label be erased without breaking the chain', () => {
    const { db } = newProject();
    addFile(db);
    expect(() => db.prepare('DELETE FROM audit_event').run()).toThrow(/append-only/);
    expect(() =>
      db.prepare(`UPDATE audit_event SET detail = '{}' WHERE id = 1`).run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare(`UPDATE audit_event SET actor_label = 'someone' WHERE id = 1`).run(),
    ).toThrow(/append-only/);

    db.prepare(`UPDATE audit_event SET actor_label = '[erased]' WHERE id = 1`).run();
    expect(verifyAudit(db)).toEqual({ events: 1, brokenAt: null });
    db.close();
  });

  it('refuses an action that cannot happen in a project file', () => {
    const { db } = newProject();
    expect(() =>
      db
        .prepare(
          `INSERT INTO audit_event (id, at, actor, action, subject_type, chain_hash)
           VALUES (1, '2026-01-01', 'cli:x', 'auth.login', 'account', 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});

describe('every write path records its event', () => {
  it('file.added carries the original DOCX digest', () => {
    const { db } = newProject();
    const file = addFile(db);
    const [event] = listEvents(db, { subjectType: 'file', subjectId: String(file.id) });
    expect(event).toMatchObject({
      actor: 'cli:test',
      actorLabel: 'test',
      action: 'file.added',
    });
    expect(detailOf<'file.added'>(event!.detail)).toEqual({
      rel_path: 'a.docx',
      sha256: sha256(DOCX),
    });
    db.close();
  });

  it('two edits leave two snapshots, and an edit that changes nothing leaves none', () => {
    const { db } = newProject();
    const segment = plainSegment(db, addFile(db).id);
    const edit = (v: string) =>
      setSegmentTarget(db, segment.id, {
        targetTokens: text(v),
        status: 'translated',
        origin: null,
        actor: TEST_ACTOR,
      });

    expect(edit('uno')).toBe(true);
    expect(edit('dos')).toBe(true);
    expect(edit('dos')).toBe(false);

    const events = listEvents(db, {
      subjectType: 'segment',
      subjectId: String(segment.id),
    });
    expect(events.map((e) => e.action)).toEqual([
      'segment.target_set',
      'segment.target_set',
    ]);
    expect(
      events.map((e) => detailOf<'segment.target_set'>(e.detail).target_tokens),
    ).toEqual([text('uno'), text('dos')]);
    db.close();
  });

  it('confirming records the new state, then the TM unit it wrote, labelled in the .ctm', () => {
    const { db } = newProject();
    const segment = plainSegment(db, addFile(db).id);
    const ctm = join(dir, 'w.ctm');
    createTm(ctm, { name: 'w', generator: 'test' }).close();
    const ref = addTmRef(db, { path: ctm, priority: 1, isWriteTarget: true });
    setSegmentTarget(db, segment.id, {
      targetTokens: text('hola'),
      status: 'translated',
      origin: null,
      actor: TEST_ACTOR,
    });
    const reviewer = {
      actor: { kind: 'account', id: 7 },
      label: 'rev@example.com',
    } as const;
    const { tuId } = confirmSegment(db, segment.id, { actor: reviewer });

    const events = listEvents(db, {
      subjectType: 'segment',
      subjectId: String(segment.id),
    });
    expect(events.map((e) => [e.action, e.actor])).toEqual([
      ['segment.target_set', 'cli:test'],
      ['segment.target_set', 'account:7'],
      ['segment.confirmed', 'account:7'],
    ]);
    expect(detailOf<'segment.target_set'>(events[1]!.detail).status).toBe('confirmed');
    const { uuid, updated_by } = db
      .prepare(
        `SELECT t.uuid, v.updated_by FROM ${tmAlias(ref.id)}.tu t
         JOIN ${tmAlias(ref.id)}.tuv v ON v.tu_id = t.id WHERE t.id = ? LIMIT 1`,
      )
      .get(tuId) as { uuid: string; updated_by: string };
    expect(detailOf<'segment.confirmed'>(events[2]!.detail)).toEqual({
      tm_write: { tu_uuid: uuid, rev: 1 },
    });
    expect(updated_by).toBe('rev@example.com');
    db.close();
  });

  it('a pre-translate run is one parent event, and what it changed is listable by its id', () => {
    const { db } = newProject();
    const a = addFile(db, 'a.docx');
    const b = addFile(db, 'b.docx'); // same content: every segment has a donor in a
    const donor = plainSegment(db, a.id);
    const ctm = join(dir, 'w.ctm');
    createTm(ctm, { name: 'w', generator: 'test' }).close();
    addTmRef(db, { path: ctm, priority: 1, isWriteTarget: true });
    setSegmentTarget(db, donor.id, {
      targetTokens: text('hola'),
      status: 'translated',
      origin: null,
      actor: TEST_ACTOR,
    });
    confirmSegment(db, donor.id, { actor: TEST_ACTOR });

    const summary = pretranslate(db, { fileId: b.id, actor: TEST_ACTOR });
    const [run] = listEvents(db, { subjectType: 'project', subjectId: null });
    expect(run!.action).toBe('project.pretranslate');
    expect(detailOf<'project.pretranslate'>(run!.detail)).toEqual({
      tm_refs: [ctm],
      counts: summary,
    });
    const children = listBatch(db, run!.id);
    expect(children.length).toBe(summary.exact + summary.tagdiff + summary.propagated);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((e) => e.action === 'segment.target_set')).toBe(true);
    expect(new Set(children.map((e) => e.subjectId))).toContain(
      String(listSegments(db, b.id).find((s) => s.sourceHash === donor.sourceHash)!.id),
    );

    // A re-run changes nothing: its parent is logged, with no children.
    pretranslate(db, { fileId: b.id, actor: TEST_ACTOR });
    const runs = listEvents(db, { subjectType: 'project', subjectId: null });
    expect(runs).toHaveLength(2);
    expect(listBatch(db, runs[1]!.id)).toEqual([]);
    db.close();
  });

  it('project.exported carries the digest of exactly the bytes produced', () => {
    const { db } = newProject();
    const file = addFile(db);
    const { bytes } = exportFile(db, file.id, { actor: TEST_ACTOR });
    const events = listEvents(db, { subjectType: 'file', subjectId: String(file.id) });
    expect(events.map((e) => e.action)).toEqual(['file.added', 'project.exported']);
    expect(detailOf<'project.exported'>(events[1]!.detail)).toEqual({
      sha256: sha256(bytes),
    });
    db.close();
  });
});

describe('verifyAudit', () => {
  it('is green on a fresh project and red after a raw-SQL tamper', () => {
    const { db } = newProject();
    expect(verifyAudit(db)).toEqual({ events: 0, brokenAt: null });

    const segment = plainSegment(db, addFile(db).id);
    for (const v of ['uno', 'dos', 'tres']) {
      setSegmentTarget(db, segment.id, {
        targetTokens: text(v),
        status: 'translated',
        origin: null,
        actor: TEST_ACTOR,
      });
    }
    expect(verifyAudit(db)).toEqual({ events: 4, brokenAt: null });

    // Someone with the file and sqlite3: drop the guard, rewrite history.
    db.exec('DROP TRIGGER audit_event_no_update');
    db.prepare(
      `UPDATE audit_event SET detail = replace(detail, 'dos', 'DOS') WHERE id = 3`,
    ).run();
    expect(verifyAudit(db)).toEqual({ events: 4, brokenAt: 3 });
    db.close();
  });
});

describe('migrating a v4 project', () => {
  it('writes one segment.baseline per segment with a target, by system:migration', () => {
    dir = mkdtempSync(join(tmpdir(), 'cat-audit-'));
    const path = join(dir, 'old.catdb');
    const old = openAndMigrate(path, {
      applicationId: PROJECT_APPLICATION_ID,
      migrations: PROJECT_MIGRATIONS.slice(0, 4),
    });
    old.exec(`
      INSERT INTO file (id, rel_path, original_blob, skeleton, part_map, imported_at)
        VALUES (1, 'a.docx', x'00', '[]', '[]', '2026-01-01');
      INSERT INTO segment
        (id, file_id, part, ord, para_key, para_ord, source_tokens, format_table,
         target_tokens, source_hash, status, origin, updated_at)
      VALUES
        (1, 1, 'document', 0, 'p1', 0, '[]', '[]', '[{"t":"text","v":"hola"}]', 'h1', 'confirmed', 'tm_exact', '2026-01-01'),
        (2, 1, 'document', 1, 'p1', 1, '[]', '[]', NULL,                        'h2', 'new',       NULL,       '2026-01-01'),
        (3, 1, 'document', 2, 'p2', 0, '[]', '[]', '[{"t":"text","v":"adiós"}]', 'h3', 'draft',     'propagated', '2026-01-01');
    `);
    old.close();

    const db = openProjectDb(path);
    const events = listEvents(db, { subjectType: 'segment' });
    expect(events.map((e) => [e.subjectId, e.action, e.actor, e.actorLabel])).toEqual([
      ['1', 'segment.baseline', 'system:migration', null],
      ['3', 'segment.baseline', 'system:migration', null],
    ]);
    expect(detailOf<'segment.baseline'>(events[1]!.detail)).toEqual({
      status: 'draft',
      origin: 'propagated',
      target_tokens: text('adiós'),
    });
    expect(verifyAudit(db)).toEqual({ events: 2, brokenAt: null });
    db.close();
  });
});
