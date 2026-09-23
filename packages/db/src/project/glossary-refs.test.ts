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
  GlossaryRefError,
  listGlossaryRefs,
  resolveRendering,
  setGlossaryWriteTarget,
} from './glossary-refs.js';
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
    addGlossaryRef(db, { path: 'base.ctg', priority: 2 });
    addGlossaryRef(db, { path: 'client.ctg', priority: 1 });
    expect(listGlossaryRefs(db).map((r) => r.path)).toEqual(['client.ctg', 'base.ctg']);
    db.close();
  });

  it('moves the write target atomically and refuses an unknown id', () => {
    const db = openProjectDb(dbPath());
    const a = addGlossaryRef(db, { path: 'a.ctg', priority: 1, isWriteTarget: true });
    const b = addGlossaryRef(db, { path: 'b.ctg', priority: 2 });
    setGlossaryWriteTarget(db, b.id);
    const refs = listGlossaryRefs(db);
    expect(refs.find((r) => r.id === a.id)!.isWriteTarget).toBe(false);
    expect(refs.find((r) => r.id === b.id)!.isWriteTarget).toBe(true);
    expect(() => setGlossaryWriteTarget(db, 999)).toThrow(GlossaryRefError);
    // The partial unique index is the real guard, not the repository.
    expect(() =>
      db.prepare('UPDATE glossary_ref SET is_write_target = 1 WHERE id = ?').run(a.id),
    ).toThrow(/UNIQUE/);
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
    const base = addGlossaryRef(db, { path: ctgPath('base.ctg'), priority: 2 });
    const acme = addGlossaryRef(db, { path: ctgPath('acme.ctg'), priority: 1 });
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
    addGlossaryRef(db, { path: ctgPath('acme.ctg'), priority: 1, enabled: false });
    const refs = listGlossaryRefs(db);
    expect(attachGlossaries(db, refs)).toEqual([]);
    expect(
      resolveRendering(db, refs, { srcLang: 'en', srcText: 'software', tgtLang: 'es' }),
    ).toBe(null);
    db.close();
  });
});
