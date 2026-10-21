import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { createTm } from '../tm/index.js';
import { unit } from '../tm/unit.fixture.js';
import { searchConcordance } from './concordance.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import { addTmRef, listTmRefs } from './tm-refs.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A project (en to de) with one memory per entry, each holding the given source texts. */
function setup(memories: ReadonlyArray<{ texts: string[]; enabled?: boolean }>) {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-concordance-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'de' });
  memories.forEach((memory, i) => {
    const path = join(dir, `m${i}.ctm`);
    const tm = createTm(path, { name: `m${i}`, generator: 'test' });
    for (const text of memory.texts) {
      unit(tm, [
        { lang: 'en-US', text },
        { lang: 'de-DE', text: `de: ${text}` },
      ]);
    }
    tm.close();
    addTmRef(db, {
      actor: TEST_ACTOR,
      path,
      priority: i + 1,
      enabled: memory.enabled ?? true,
    });
  });
  return db;
}

describe('searchConcordance', () => {
  it('searches the attached memories in priority order and names each by position', () => {
    const db = setup([
      { texts: ['Print the page'] },
      { texts: ['Print later', 'Save it'] },
    ]);
    const found = searchConcordance(db, { text: 'print', side: 'source' });
    expect(found.searched).toBe(2);
    expect(found.hits.map((h) => [h.memory, h.sourcePlain])).toEqual([
      [1, 'Print the page'],
      [2, 'Print later'],
    ]);
    expect(found.hits[0]!.targetPlain).toBe('de: Print the page');
    expect(found.more).toBe(false);
    db.close();
  });

  it('leaves out a memory that is switched off', () => {
    const db = setup([
      { texts: ['Print one'], enabled: false },
      { texts: ['Print two'] },
    ]);
    const found = searchConcordance(db, { text: 'print', side: 'source' });
    expect(found.searched).toBe(1);
    expect(found.hits.map((h) => h.sourcePlain)).toEqual(['Print two']);
    db.close();
  });

  it('fills the limit from the first memories and says there is more in a later one', () => {
    const db = setup([{ texts: ['Print a', 'Print b'] }, { texts: ['Print c'] }]);
    const found = searchConcordance(db, { text: 'print', side: 'source', limit: 2 });
    expect(found.hits.map((h) => h.sourcePlain)).toEqual(['Print b', 'Print a']);
    expect(found.hits.every((h) => h.memory === 1)).toBe(true);
    expect(found.more).toBe(true);
    db.close();
  });

  it('says nothing is more when the limit is met exactly', () => {
    const db = setup([{ texts: ['Print a'] }, { texts: ['Print b'] }]);
    const found = searchConcordance(db, { text: 'print', side: 'source', limit: 2 });
    expect(found.hits).toHaveLength(2);
    expect(found.more).toBe(false);
    db.close();
  });

  it('is an empty result for a project with no memory', () => {
    const db = setup([]);
    expect(searchConcordance(db, { text: 'print', side: 'source' })).toEqual({
      hits: [],
      more: false,
      searched: 0,
    });
    db.close();
  });

  it('writes nothing and leaves no memory attached', () => {
    const db = setup([{ texts: ['Print a'] }]);
    const events = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n;
    const before = events();
    searchConcordance(db, { text: 'print', side: 'source' });
    expect(events()).toBe(before);
    expect(
      (db.pragma('database_list') as Array<{ name: string }>)
        .map((d) => d.name)
        .filter((name) => name !== 'main' && name !== 'temp'),
    ).toEqual([]);
    expect(listTmRefs(db)).toHaveLength(1);
    db.close();
  });
});
