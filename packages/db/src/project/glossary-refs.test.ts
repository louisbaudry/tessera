import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openProjectDb, PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './index.js';
import {
  addGlossaryRef,
  attachGlossaries,
  detachGlossaries,
  glossaryAlias,
  GLOSSARY_REFS_SETTING,
  GlossaryRefError,
  listGlossaryRefs,
  nextGlossaryPriority,
  resolveRendering,
  setGlossaryWriteTarget,
} from './glossary-refs.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { addVariant, createGlossary, insertTerm } from '../glossary/index.js';
import { openAndMigrate } from '../migrate.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-glossary-'));
  return join(dir, 'project.catdb');
};
const ctgPath = (name: string) => join(dir, name);

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A `.ctg` holding one EN/ES term per `[en, es]` pair given. */
const glossaryWith = (
  path: string,
  client: string | undefined,
  pairs: [string, string][],
) => {
  const g = createGlossary(path, { name: path, generator: 'test', client });
  for (const [en, es] of pairs) {
    const term = insertTerm(g);
    addVariant(g, { termId: term.id, lang: 'en', text: en });
    addVariant(g, { termId: term.id, lang: 'es', text: es });
  }
  g.close();
};

describe('project schema v2', () => {
  it('upgrades a v1 project database in place, through the shared runner', () => {
    const path = dbPath();
    openAndMigrate(path, {
      applicationId: PROJECT_APPLICATION_ID,
      migrations: [PROJECT_MIGRATIONS[0]!],
    }).close();
    const db = openProjectDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_MIGRATIONS.length);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'glossary_ref'").get(),
    ).toBeTruthy();
    db.close();
  });
});

describe('addGlossaryRef / listGlossaryRefs / setGlossaryWriteTarget', () => {
  it('lists references lowest-priority-first', () => {
    const db = openProjectDb(dbPath());
    addGlossaryRef(db, { path: 'base.ctg', priority: 2, actor: TEST_ACTOR });
    addGlossaryRef(db, { path: 'client.ctg', priority: 1, actor: TEST_ACTOR });
    expect(listGlossaryRefs(db).map((r) => r.path)).toEqual(['client.ctg', 'base.ctg']);
    db.close();
  });

  it('moves the write target atomically and refuses an unknown id', () => {
    const db = openProjectDb(dbPath());
    const a = addGlossaryRef(db, {
      path: 'a.ctg',
      priority: 1,
      isWriteTarget: true,
      actor: TEST_ACTOR,
    });
    const b = addGlossaryRef(db, { path: 'b.ctg', priority: 2, actor: TEST_ACTOR });
    setGlossaryWriteTarget(db, b.id, { actor: TEST_ACTOR });
    const refs = listGlossaryRefs(db);
    expect(refs.find((r) => r.id === a.id)!.isWriteTarget).toBe(false);
    expect(refs.find((r) => r.id === b.id)!.isWriteTarget).toBe(true);
    expect(() => setGlossaryWriteTarget(db, 999, { actor: TEST_ACTOR })).toThrow(
      GlossaryRefError,
    );
    // The partial unique index is the real guard, not the repository.
    expect(() =>
      db.prepare('UPDATE glossary_ref SET is_write_target = 1 WHERE id = ?').run(a.id),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

describe('the project log (audit-spec.md §2.4)', () => {
  it('records every change to the list as one project.setting_changed, before and after', () => {
    const db = openProjectDb(dbPath());
    const a = addGlossaryRef(db, { path: 'a.ctg', priority: 1, actor: TEST_ACTOR });
    const b = addGlossaryRef(db, {
      path: 'b.ctg',
      priority: nextGlossaryPriority(db),
      isWriteTarget: true,
      actor: TEST_ACTOR,
    });
    setGlossaryWriteTarget(db, a.id, { actor: TEST_ACTOR });
    expect(b.priority).toBe(2);

    const events = listEvents(db, { subjectType: 'project' });
    expect(events.map((e) => e.action)).toEqual(Array(3).fill('project.setting_changed'));
    expect(events.every((e) => e.actor === 'cli:test')).toBe(true);
    const detail = events.map(
      (e) =>
        JSON.parse(e.detail!) as {
          key: string;
          from: unknown[];
          to: { write_target: boolean }[];
        },
    );
    expect(detail.every((d) => d.key === GLOSSARY_REFS_SETTING)).toBe(true);
    // Each event starts where the one before it ended.
    for (let i = 1; i < detail.length; i++) {
      expect(detail[i]!.from).toEqual(detail[i - 1]!.to);
    }
    expect(detail[0]!.from).toEqual([]);
    // Taking the write target while attaching is one change, not two.
    expect(detail[1]!.to.map((r) => r.write_target)).toEqual([false, true]);
    expect(detail[2]!.to.map((r) => r.write_target)).toEqual([true, false]);
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });

  it('a refused change logs nothing', () => {
    const db = openProjectDb(dbPath());
    expect(() => setGlossaryWriteTarget(db, 7, { actor: TEST_ACTOR })).toThrow(
      GlossaryRefError,
    );
    expect(listEvents(db, { subjectType: 'project' })).toEqual([]);
    db.close();
  });
});

describe('attachGlossaries / resolveRendering', () => {
  it('the client glossary wins, and falls through to the base only when it has no entry', () => {
    const db = openProjectDb(dbPath());
    glossaryWith(ctgPath('base.ctg'), undefined, [
      ['invoice', 'factura'],
      ['software', 'software'],
    ]);
    glossaryWith(ctgPath('acme.ctg'), 'acme', [['software', 'programa']]);
    const base = addGlossaryRef(db, {
      path: ctgPath('base.ctg'),
      priority: 2,
      actor: TEST_ACTOR,
    });
    const acme = addGlossaryRef(db, {
      path: ctgPath('acme.ctg'),
      priority: 1,
      actor: TEST_ACTOR,
    });
    const refs = listGlossaryRefs(db);

    const attached = attachGlossaries(db, refs);
    expect(attached.map((r) => r.id)).toEqual([acme.id, base.id]);
    // Idempotent: a second call neither throws nor re-attaches.
    expect(attachGlossaries(db, refs).map((r) => r.id)).toEqual([acme.id, base.id]);

    const q = (srcText: string) =>
      resolveRendering(db, refs, { srcLang: 'en', srcText, tgtLang: 'es' });
    expect(q('Software')?.target.text).toBe('programa');
    expect(q('invoice')?.target.text).toBe('factura');
    expect(q('widget')).toBe(null);

    detachGlossaries(db, refs);
    const names = (db.pragma('database_list') as Array<{ name: string }>).map(
      (d) => d.name,
    );
    expect(names).not.toContain(glossaryAlias(acme.id));
    expect(names).not.toContain(glossaryAlias(base.id));
    db.close();
  });

  it('never consults a disabled glossary', () => {
    const db = openProjectDb(dbPath());
    glossaryWith(ctgPath('acme.ctg'), 'acme', [['software', 'programa']]);
    addGlossaryRef(db, {
      path: ctgPath('acme.ctg'),
      priority: 1,
      enabled: false,
      actor: TEST_ACTOR,
    });
    const refs = listGlossaryRefs(db);
    expect(attachGlossaries(db, refs)).toEqual([]);
    expect(
      resolveRendering(db, refs, { srcLang: 'en', srcText: 'software', tgtLang: 'es' }),
    ).toBe(null);
    db.close();
  });
});
