import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { retrieveConcordance } from './concordance.js';
import {
  editUnitTarget,
  MAX_UNIT_TEXT_CHARS,
  retireUnit,
  UnitEditError,
  type UnitEditFailure,
} from './edit.js';
import { createTm } from './index.js';
import { QUALITY } from './schema.js';
import { unit } from './unit.fixture.js';

let dir: string;
const dbPath = (name = 'memory.ctm') => {
  dir ??= mkdtempSync(join(tmpdir(), 'cat-tm-edit-'));
  return join(dir, name);
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

const ask = { srcLang: 'en', tgtLang: 'de' } as const;

/** The German variant of a unit: its id and revision, as a concordance hit would carry them. */
function german(db: Database.Database, tuId: number) {
  return db
    .prepare(
      'SELECT id, rev, tokens, plain, hash, quality FROM tuv WHERE tu_id = ? AND lang = ?',
    )
    .get(tuId, 'de-DE') as {
    id: number;
    rev: number;
    tokens: string;
    plain: string;
    hash: string;
    quality: number;
  };
}

const pair = (en: string, de: string) => [
  { lang: 'en-US', text: en },
  { lang: 'de-DE', text: de },
];

function failure(call: () => unknown): UnitEditFailure | null {
  try {
    call();
  } catch (err) {
    if (err instanceof UnitEditError) return err.reason;
    throw err;
  }
  return null;
}

describe('editUnitTarget', () => {
  it('replaces the text, keeps the old revision, and moves rev and quality on', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Oeffnen Sie den Dekel.'));
    const before = german(db, tu);

    const result = editUnitTarget(db, {
      tuvId: before.id,
      baseRev: before.rev,
      text: ' Öffnen Sie den Deckel. ',
      changedBy: 'owner@example.com',
    });

    expect(result).toMatchObject({
      tuId: tu,
      lang: 'de-DE',
      fromRev: 1,
      toRev: 2,
      changed: true,
    });
    const after = german(db, tu);
    expect(after.rev).toBe(2);
    expect(after.plain).toBe('Öffnen Sie den Deckel.');
    expect(JSON.parse(after.tokens)).toEqual([
      { t: 'text', v: 'Öffnen Sie den Deckel.' },
    ]);
    expect(after.hash).not.toBe(before.hash);
    expect(after.quality).toBe(QUALITY.confirmed);
    // What it was is kept, with who changed it.
    const history = db
      .prepare(
        'SELECT rev, tokens, quality, changed_by FROM tuv_history WHERE tuv_id = ?',
      )
      .all(before.id);
    expect(history).toEqual([
      {
        rev: 1,
        tokens: before.tokens,
        quality: before.quality,
        changed_by: 'owner@example.com',
      },
    ]);
    db.close();
  });

  it('is found by the new text and no longer by the old', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Oeffnen Sie den Dekel.'));
    const v = german(db, tu);
    editUnitTarget(db, {
      tuvId: v.id,
      baseRev: v.rev,
      text: 'Deckel auf',
      changedBy: null,
    });
    const find = (text: string) =>
      retrieveConcordance(db, { ...ask, text, side: 'target' }).hits.length;
    expect(find('dekel')).toBe(0);
    expect(find('deckel')).toBe(1);
    db.close();
  });

  it('drops a stored vector of the old text', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Oeffnen Sie den Dekel.'));
    const v = german(db, tu);
    db.prepare(
      "INSERT INTO tuv_vec (tuv_id, model, dim, vec) VALUES (?, 'm', 1, x'00')",
    ).run(v.id);
    editUnitTarget(db, {
      tuvId: v.id,
      baseRev: v.rev,
      text: 'Deckel auf',
      changedBy: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv_vec').get()).toEqual({ n: 0 });
    db.close();
  });

  it('writes nothing when the text is already what was asked for', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    const result = editUnitTarget(db, {
      tuvId: v.id,
      baseRev: v.rev,
      text: 'Deckel auf',
      changedBy: 'x',
    });
    expect(result).toMatchObject({ changed: false, fromRev: 1, toRev: 1 });
    expect(german(db, tu).rev).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv_history').get()).toEqual({ n: 0 });
    db.close();
  });

  it('refuses a stale write, a blank text, a retired unit and a missing variant', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Oeffnen'));
    const v = german(db, tu);
    editUnitTarget(db, {
      tuvId: v.id,
      baseRev: v.rev,
      text: 'Deckel auf',
      changedBy: null,
    });
    // The first write moved the revision: the same base is now stale.
    expect(
      failure(() =>
        editUnitTarget(db, {
          tuvId: v.id,
          baseRev: v.rev,
          text: 'Anders',
          changedBy: null,
        }),
      ),
    ).toBe('stale');
    expect(
      failure(() =>
        editUnitTarget(db, {
          tuvId: v.id,
          baseRev: 2,
          text: ' \u000B ',
          changedBy: null,
        }),
      ),
    ).toBe('blank');
    expect(
      failure(() =>
        editUnitTarget(db, { tuvId: 9999, baseRev: 1, text: 'x', changedBy: null }),
      ),
    ).toBe('not_found');
    retireUnit(db, { tuvId: v.id, baseRev: 2, changedBy: null });
    expect(
      failure(() =>
        editUnitTarget(db, { tuvId: v.id, baseRev: 2, text: 'x', changedBy: null }),
      ),
    ).toBe('not_found');
    db.close();
  });

  it('refuses a text longer than a segment', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    const edit = (text: string) => () =>
      editUnitTarget(db, { tuvId: v.id, baseRev: 1, text, changedBy: null });
    expect(failure(edit('a'.repeat(MAX_UNIT_TEXT_CHARS + 1)))).toBe('too_long');
    expect(failure(edit('a'.repeat(MAX_UNIT_TEXT_CHARS)))).toBeNull();
    db.close();
  });

  it('refuses a variant that holds tags, which a text edit would lose', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    db.prepare('UPDATE tuv SET tokens = ? WHERE id = ?').run(
      JSON.stringify([
        { t: 'open', id: 1, k: 'bold' },
        { t: 'text', v: 'Deckel auf' },
        { t: 'close', id: 1 },
      ]),
      v.id,
    );
    expect(
      failure(() =>
        editUnitTarget(db, { tuvId: v.id, baseRev: 1, text: 'x', changedBy: null }),
      ),
    ).toBe('tagged');
    expect(german(db, tu).rev).toBe(1);
    db.close();
  });

  it('refuses a read-only memory', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    db.prepare('UPDATE tm SET read_only = 1').run();
    expect(
      failure(() =>
        editUnitTarget(db, { tuvId: v.id, baseRev: 1, text: 'x', changedBy: null }),
      ),
    ).toBe('read_only');
    expect(
      failure(() => retireUnit(db, { tuvId: v.id, baseRev: 1, changedBy: null })),
    ).toBe('read_only');
    db.close();
  });

  it('strips what XML cannot carry, so an export of the memory stays valid', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    editUnitTarget(db, {
      tuvId: v.id,
      baseRev: 1,
      text: 'Deckel\u0001 auf\u000Bzu',
      changedBy: null,
    });
    expect(german(db, tu).plain).toBe('Deckel auf zu');
    db.close();
  });
});

describe('retireUnit', () => {
  it('tombstones the unit, moves its revision and says who and when', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    const result = retireUnit(db, {
      tuvId: v.id,
      baseRev: v.rev,
      changedBy: 'owner@example.com',
    });
    expect(result).toMatchObject({ tuId: tu, changed: true });
    expect(db.prepare('SELECT deleted, rev FROM tu WHERE id = ?').get(tu)).toEqual({
      deleted: 1,
      rev: 2,
    });
    const attrs = Object.fromEntries(
      (
        db.prepare('SELECT key, value FROM tu_attr WHERE tu_id = ?').all(tu) as Array<{
          key: string;
          value: string;
        }>
      ).map((a) => [a.key, a.value]),
    );
    expect(attrs['x-retired-by']).toBe('owner@example.com');
    expect(attrs['x-retired-at']).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Nothing is deleted: the rows are still there for compaction to decide.
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv WHERE tu_id = ?').get(tu)).toEqual({
      n: 2,
    });
    db.close();
  });

  it('is no longer found, in either language', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    retireUnit(db, { tuvId: v.id, baseRev: v.rev, changedBy: null });
    expect(retrieveConcordance(db, { ...ask, text: 'lid', side: 'source' }).hits).toEqual(
      [],
    );
    expect(
      retrieveConcordance(db, { ...ask, text: 'deckel', side: 'target' }).hits,
    ).toEqual([]);
    db.close();
  });

  it('is a no-op the second time, and refuses a stale revision the first', () => {
    const db = createTm(dbPath(), { name: 't', generator: 'test' });
    const tu = unit(db, pair('Open the lid.', 'Deckel auf'));
    const v = german(db, tu);
    expect(
      failure(() => retireUnit(db, { tuvId: v.id, baseRev: 7, changedBy: null })),
    ).toBe('stale');
    retireUnit(db, { tuvId: v.id, baseRev: 1, changedBy: null });
    const again = retireUnit(db, { tuvId: v.id, baseRev: 1, changedBy: null });
    expect(again.changed).toBe(false);
    expect(db.prepare('SELECT rev FROM tu WHERE id = ?').get(tu)).toEqual({ rev: 2 });
    expect(
      failure(() => retireUnit(db, { tuvId: 9999, baseRev: 1, changedBy: null })),
    ).toBe('not_found');
    db.close();
  });
});

describe('through an attached memory', () => {
  it('edits and retires by schema alias, as a project connection reaches a memory', () => {
    const memory = createTm(dbPath('mem.ctm'), { name: 't', generator: 'test' });
    const tu = unit(memory, pair('Open the lid.', 'Dekel auf'));
    const v = german(memory, tu);
    memory.close();

    const host = createTm(dbPath('host.ctm'), { name: 'h', generator: 'test' });
    host.prepare('ATTACH DATABASE ? AS mem').run(dbPath('mem.ctm'));
    const schema = { schema: 'mem' };
    editUnitTarget(
      host,
      { tuvId: v.id, baseRev: v.rev, text: 'Deckel auf', changedBy: null },
      schema,
    );
    expect(
      retrieveConcordance(host, { ...ask, text: 'deckel', side: 'target' }, schema).hits,
    ).toHaveLength(1);
    retireUnit(host, { tuvId: v.id, baseRev: 2, changedBy: null }, schema);
    expect(
      retrieveConcordance(host, { ...ask, text: 'deckel', side: 'target' }, schema).hits,
    ).toEqual([]);
    host.close();
  });
});
