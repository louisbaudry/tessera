import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { UnitEditError } from '../tm/edit.js';
import { createTm } from '../tm/index.js';
import { unit } from '../tm/unit.fixture.js';
import { searchConcordance } from './concordance.js';
import { openProjectDb } from './index.js';
import { editMemoryUnit, NoSuchMemoryError, retireMemoryUnit } from './memory-units.js';
import { createProject } from './project.js';
import { addTmRef } from './tm-refs.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A project (en to de) with one memory holding one unit; returns what a hit would carry. */
function setup(options: { enabled?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'cat-memory-units-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'de' });
  const path = join(dir, 'm.ctm');
  const tm = createTm(path, { name: 'm', generator: 'test' });
  unit(tm, [
    { lang: 'en-US', text: 'Open the lid.' },
    { lang: 'de-DE', text: 'Dekel auf' },
  ]);
  tm.close();
  const ref = addTmRef(db, {
    actor: TEST_ACTOR,
    path,
    priority: 1,
    enabled: options.enabled ?? true,
  });
  const hit = () => searchConcordance(db, { text: 'lid', side: 'source' }).hits[0]!;
  return { db, ref: ref.id, path, hit };
}

/** The memory events in the project's log, their `detail` parsed from its stored JSON. */
const events = (db: Database.Database) =>
  listEvents(db, { subjectType: 'project' })
    .filter((e) => e.action.startsWith('tm.'))
    .map((e) => ({ ...e, detail: JSON.parse(e.detail ?? 'null') as unknown }));

describe('editMemoryUnit', () => {
  it('writes the memory and logs who, which memory and which revisions, never the text', () => {
    const { db, ref, hit } = setup();
    const h = hit();
    expect(h).toMatchObject({ ref, editable: true, targetRev: 1 });

    const result = editMemoryUnit(db, {
      ref,
      tuvId: h.targetTuvId,
      baseRev: h.targetRev,
      text: 'Deckel auf',
      actor: TEST_ACTOR,
    });

    expect(result).toMatchObject({ changed: true, fromRev: 1, toRev: 2 });
    expect(hit().targetPlain).toBe('Deckel auf');
    const [event] = events(db);
    expect(event).toMatchObject({
      action: 'tm.unit_edited',
      subjectType: 'project',
      detail: {
        tm_ref: ref,
        tu_uuid: result.tuUuid,
        lang: 'de-DE',
        from_rev: 1,
        to_rev: 2,
      },
    });
    // The text is client content in a hashed detail that could never be erased.
    expect(JSON.stringify(event)).not.toMatch(/Deckel|Dekel/);
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });

  it('logs nothing when nothing changed', () => {
    const { db, ref, hit } = setup();
    const h = hit();
    editMemoryUnit(db, {
      ref,
      tuvId: h.targetTuvId,
      baseRev: h.targetRev,
      text: 'Dekel auf',
      actor: TEST_ACTOR,
    });
    expect(events(db)).toEqual([]);
    db.close();
  });

  it('logs nothing, and writes nothing, when the memory refuses', () => {
    const { db, ref, hit } = setup();
    const h = hit();
    expect(() =>
      editMemoryUnit(db, {
        ref,
        tuvId: h.targetTuvId,
        baseRev: 5,
        text: 'x',
        actor: TEST_ACTOR,
      }),
    ).toThrow(UnitEditError);
    expect(hit().targetPlain).toBe('Dekel auf');
    expect(events(db)).toEqual([]);
    db.close();
  });

  it('names the memory by the project’s reference: an unknown or switched-off one is refused', () => {
    const { db, ref, hit } = setup();
    const h = hit();
    const params = {
      tuvId: h.targetTuvId,
      baseRev: h.targetRev,
      text: 'x',
      actor: TEST_ACTOR,
    };
    expect(() => editMemoryUnit(db, { ...params, ref: ref + 99 })).toThrow(
      NoSuchMemoryError,
    );
    db.close();

    const off = setup({ enabled: false });
    expect(() =>
      editMemoryUnit(off.db, { ...params, ref: off.ref, tuvId: 1, baseRev: 1 }),
    ).toThrow(NoSuchMemoryError);
    off.db.close();
  });

  it('leaves no memory attached to the project connection', () => {
    const { db, ref, hit } = setup();
    const h = hit();
    editMemoryUnit(db, {
      ref,
      tuvId: h.targetTuvId,
      baseRev: h.targetRev,
      text: 'Deckel auf',
      actor: TEST_ACTOR,
    });
    expect(
      (db.pragma('database_list') as Array<{ name: string }>)
        .map((d) => d.name)
        .filter((n) => n !== 'main' && n !== 'temp'),
    ).toEqual([]);
    db.close();
  });
});

describe('retireMemoryUnit', () => {
  it('tombstones the unit and logs it, and a second call changes and logs nothing', () => {
    const { db, ref, hit } = setup();
    const h = hit();
    const params = { ref, tuvId: h.targetTuvId, baseRev: h.targetRev, actor: TEST_ACTOR };
    const result = retireMemoryUnit(db, params);
    expect(result.changed).toBe(true);
    expect(searchConcordance(db, { text: 'lid', side: 'source' }).hits).toEqual([]);
    expect(events(db)).toHaveLength(1);
    expect(events(db)[0]).toMatchObject({
      action: 'tm.unit_retired',
      detail: { tm_ref: ref, tu_uuid: result.tuUuid },
    });
    expect(retireMemoryUnit(db, params).changed).toBe(false);
    expect(events(db)).toHaveLength(1);
    expect(verifyAudit(db).brokenAt).toBeNull();
    db.close();
  });
});
