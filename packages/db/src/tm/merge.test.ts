import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashOf, normalizeTokens } from '@cat-tool/core';
import type { AuditActor, TmToken } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { createTm, openTm, TM_APPLICATION_ID } from './index.js';
import { mergeTm, type MergeTmResult } from './merge.js';
import { retrievePair } from './retrieve.js';
import { writeBack } from './write.js';

let dir: string | undefined;
const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const path = (name: string) => {
  dir ??= mkdtempSync(join(tmpdir(), 'cat-tm-merge-'));
  return join(dir, `${name}.ctm`);
};
const memory = (name: string): Database.Database => {
  const db = createTm(path(name), { name, generator: 'test' });
  open.push(db);
  return db;
};
const reopen = (name: string): Database.Database => {
  const db = openTm(path(name));
  open.push(db);
  return db;
};
const text = (v: string): TmToken[] => [{ t: 'text', v }];
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

interface VariantSpec {
  readonly lang: string;
  readonly text: string;
  readonly rev?: number;
  readonly updatedAt?: string;
  readonly quality?: number;
  readonly usage?: number;
  readonly history?: readonly { rev: number; text: string; quality?: number }[];
}
interface UnitSpec {
  readonly uuid: string;
  readonly variants: readonly VariantSpec[];
  readonly deleted?: boolean;
  readonly rev?: number;
  readonly updatedAt?: string;
  readonly attrs?: Record<string, string>;
}

/** Writes a unit exactly as specified — uuid, revs, times — which `writeBack` never lets a test do. */
function put(db: Database.Database, u: UnitSpec): number {
  const tu = db
    .prepare(
      `INSERT INTO tu (uuid, rev, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(u.uuid, u.rev ?? 1, T0, u.updatedAt ?? T0, u.deleted ? 1 : 0)
    .lastInsertRowid as number;
  for (const [key, value] of Object.entries(u.attrs ?? {})) {
    db.prepare('INSERT INTO tu_attr (tu_id, key, value) VALUES (?, ?, ?)').run(
      tu,
      key,
      value,
    );
  }
  for (const v of u.variants) {
    const tokens = text(v.text);
    const { plain, hash } = normalizeTokens(tokens);
    const tuv = db
      .prepare(
        `INSERT INTO tuv (tu_id, lang, rev, tokens, plain, hash, quality, usage_count,
                          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tu,
        v.lang,
        v.rev ?? 1,
        JSON.stringify(tokens),
        plain,
        hash,
        v.quality ?? 2,
        v.usage ?? 0,
        T0,
        v.updatedAt ?? T0,
      ).lastInsertRowid as number;
    for (const h of v.history ?? []) {
      db.prepare(
        `INSERT INTO tuv_history (tuv_id, rev, tokens, quality, changed_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(tuv, h.rev, JSON.stringify(text(h.text)), h.quality ?? 2, T0);
    }
  }
  db.prepare(
    `UPDATE tm SET langs = (SELECT json_group_array(lang) FROM (SELECT DISTINCT lang FROM tuv ORDER BY lang))`,
  ).run();
  return tu;
}

/**
 * A copy of a memory's file, taken once its connection is closed: a
 * checkpointed WAL means the main file is the whole memory.
 */
function closeCopy(db: Database.Database, from: string, to: string): void {
  db.close();
  copyFileSync(path(from), path(to));
}

const uid = () => randomUUID();
const alice: AuditActor = { actor: { kind: 'cli', name: 'alice' }, label: 'alice' };

/** Everything a merge is meant to make equal, keyed by uuid and lang so row ids do not matter. */
function dump(db: Database.Database, withProvenance = true) {
  const units = db
    .prepare(
      `SELECT uuid, rev, created_at, updated_at, created_by, origin_doc, origin_project, deleted
       FROM tu ORDER BY uuid`,
    )
    .all() as Array<{
    uuid: string;
    rev: number;
    created_at: string;
    updated_at: string;
    created_by: string | null;
    origin_doc: string | null;
    origin_project: string | null;
    deleted: number;
  }>;
  const attrs = db
    .prepare(
      `SELECT u.uuid, a.key, a.value FROM tu_attr a JOIN tu u ON u.id = a.tu_id
       ORDER BY u.uuid, a.key`,
    )
    .all() as Array<{ uuid: string; key: string; value: string }>;
  const variants = db
    .prepare(
      `SELECT u.uuid, v.lang, v.rev, v.tokens, v.plain, v.hash, v.prev_hash, v.next_hash,
              v.quality, v.usage_count, v.last_used_at, v.created_at, v.updated_at, v.updated_by
       FROM tuv v JOIN tu u ON u.id = v.tu_id ORDER BY u.uuid, v.lang`,
    )
    .all() as Array<{
    uuid: string;
    lang: string;
    rev: number;
    tokens: string;
    plain: string;
    hash: string;
    prev_hash: string | null;
    next_hash: string | null;
    quality: number;
    usage_count: number;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
    updated_by: string | null;
  }>;
  const history = db
    .prepare(
      `SELECT u.uuid, v.lang, h.rev, h.tokens, h.quality
              ${withProvenance ? ', h.changed_at, h.changed_by' : ''}
       FROM tuv_history h JOIN tuv v ON v.id = h.tuv_id JOIN tu u ON u.id = v.tu_id
       ORDER BY u.uuid, v.lang, h.rev`,
    )
    .all() as Array<{
    uuid: string;
    lang: string;
    rev: number;
    tokens: string;
    quality: number;
    changed_at?: string;
    changed_by?: string | null;
  }>;
  const langs = JSON.parse(
    (db.prepare('SELECT langs FROM tm').get() as { langs: string }).langs,
  ) as string[];
  return { units, attrs, variants, history, langs };
}

const variant = (db: Database.Database, uuid: string, lang: string) =>
  db
    .prepare(
      `SELECT v.rev, v.tokens, v.quality, v.usage_count, v.last_used_at, v.updated_at
       FROM tuv v JOIN tu u ON u.id = v.tu_id WHERE u.uuid = ? AND v.lang = ?`,
    )
    .get(uuid, lang) as
    | {
        rev: number;
        tokens: string;
        quality: number;
        usage_count: number;
        last_used_at: string | null;
        updated_at: string;
      }
    | undefined;
const tokensOf = (db: Database.Database, uuid: string, lang: string) =>
  (JSON.parse(variant(db, uuid, lang)!.tokens) as TmToken[])
    .map((t) => (t.t === 'text' ? t.v : ''))
    .join('');
const historyOf = (db: Database.Database, uuid: string, lang: string) =>
  (
    db
      .prepare(
        `SELECT h.rev, h.tokens, h.changed_by FROM tuv_history h
         JOIN tuv v ON v.id = h.tuv_id JOIN tu u ON u.id = v.tu_id
         WHERE u.uuid = ? AND v.lang = ? ORDER BY h.rev`,
      )
      .all(uuid, lang) as { rev: number; tokens: string; changed_by: string | null }[]
  ).map((h) => ({
    rev: h.rev,
    text: (JSON.parse(h.tokens) as TmToken[])
      .map((t) => (t.t === 'text' ? t.v : ''))
      .join(''),
    by: h.changed_by,
  }));

const digest = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

const NOTHING: Partial<MergeTmResult> = {
  unitsAdded: 0,
  tombstonesPropagated: 0,
  variantsAdded: 0,
  variantsReplaced: 0,
  variantsKept: 0,
  historyRetained: 0,
  historyCopied: 0,
  historyConflicts: 0,
  warnings: [],
};

describe('merging a memory with itself', () => {
  it('is a no-op for the same file', () => {
    const a = memory('a');
    put(a, {
      uuid: uid(),
      variants: [
        { lang: 'en', text: 'Hello' },
        { lang: 'es', text: 'Hola' },
      ],
    });
    const before = dump(a);
    expect(mergeTm(a, path('a'), { actor: TEST_ACTOR })).toMatchObject(NOTHING);
    expect(dump(a)).toEqual(before);
  });

  it('is a no-op for an identical copy, which is what a handed-out memory comes back as', () => {
    const a = memory('a');
    put(a, {
      uuid: uid(),
      attrs: { client: 'acme' },
      variants: [
        {
          lang: 'en',
          text: 'Hello',
          rev: 3,
          history: [
            { rev: 1, text: 'Hi' },
            { rev: 2, text: 'Hey' },
          ],
        },
        { lang: 'es', text: 'Hola', usage: 4 },
      ],
    });
    put(a, { uuid: uid(), deleted: true, variants: [{ lang: 'en', text: 'Gone' }] });
    closeCopy(a, 'a', 'copy');
    const db = reopen('a');
    const before = dump(db);
    const result = mergeTm(db, path('copy'), { actor: TEST_ACTOR });
    expect(result).toMatchObject(NOTHING);
    expect(dump(db)).toEqual(before);
  });
});

describe('units in one memory only', () => {
  it('copies the unit with its variants, attributes and history, and makes it retrievable', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(b, {
      uuid,
      attrs: { client: 'acme', note: 'n' },
      variants: [
        { lang: 'en', text: 'Save', rev: 2, history: [{ rev: 1, text: 'Store' }] },
        { lang: 'es', text: 'Guardar' },
      ],
    });
    b.close();
    const result = mergeTm(a, path('b'), { actor: alice });
    expect(result).toMatchObject({ unitsAdded: 1, variantsAdded: 2, historyCopied: 1 });
    expect(historyOf(a, uuid, 'en')).toEqual([{ rev: 1, text: 'Store', by: null }]);
    expect(variant(a, uuid, 'en')!.rev).toBe(2);
    expect(dump(a).attrs).toEqual([
      { uuid, key: 'client', value: 'acme' },
      { uuid, key: 'note', value: 'n' },
    ]);
    expect(dump(a).langs).toEqual(['en', 'es']);
    const hit = retrievePair(a, {
      srcLang: 'en',
      srcHash: hashOf('Save'),
      tgtLang: 'es',
    });
    expect(hit.map((m) => m.tokens)).toEqual([text('Guardar')]);
  });

  it('keeps the full-text index in step', () => {
    const a = memory('a');
    const b = memory('b');
    put(b, { uuid: uid(), variants: [{ lang: 'es', text: 'La acción' }] });
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    const found = a
      .prepare(`SELECT COUNT(*) AS n FROM tuv_fts WHERE tuv_fts MATCH 'accion'`)
      .get() as { n: number };
    expect(found.n).toBe(1);
  });

  it('copies a language one memory has and the other lacks, linking units by uuid', () => {
    // EN/ES merged with EN/DE: the shared unit gains a language, and nothing is duplicated.
    const a = memory('a');
    const b = memory('b');
    const shared = uid();
    put(a, {
      uuid: shared,
      variants: [
        { lang: 'en', text: 'Save' },
        { lang: 'es', text: 'Guardar' },
      ],
    });
    put(b, {
      uuid: shared,
      variants: [
        { lang: 'en', text: 'Save' },
        { lang: 'de', text: 'Speichern' },
      ],
    });
    b.close();
    const result = mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(result).toMatchObject({ unitsAdded: 0, variantsAdded: 1 });
    expect(a.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 1 });
    expect(dump(a).variants.map((v) => v.lang)).toEqual(['de', 'en', 'es']);
    expect(dump(a).langs).toEqual(['de', 'en', 'es']);
    expect(
      retrievePair(a, { srcLang: 'es', srcHash: hashOf('Guardar'), tgtLang: 'de' }),
    ).toHaveLength(1);
  });

  it('keeps two different units with the same hash: they are two translations, not one', () => {
    const a = memory('a');
    const b = memory('b');
    put(a, {
      uuid: uid(),
      variants: [
        { lang: 'en', text: 'Charge' },
        { lang: 'es', text: 'Cargo' },
      ],
    });
    put(b, {
      uuid: uid(),
      variants: [
        { lang: 'en', text: 'Charge' },
        { lang: 'es', text: 'Carga' },
      ],
    });
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    const hits = retrievePair(a, {
      srcLang: 'en',
      srcHash: hashOf('Charge'),
      tgtLang: 'es',
    });
    expect(
      hits
        .map((m) => m.tokens)
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    ).toEqual([text('Carga'), text('Cargo')]);
  });
});

describe('a variant in both: higher rev wins, later updated_at breaks a tie', () => {
  it('takes the source’s when its rev is higher, and retains the destination’s at its own rev', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, { uuid, variants: [{ lang: 'es', text: 'viejo', rev: 2, updatedAt: T2 }] });
    put(b, { uuid, variants: [{ lang: 'es', text: 'nuevo', rev: 3, updatedAt: T1 }] });
    b.close();
    const result = mergeTm(a, path('b'), { actor: alice });
    expect(result).toMatchObject({ variantsReplaced: 1, historyRetained: 1 });
    expect(tokensOf(a, uuid, 'es')).toBe('nuevo'); // rev beats a later updated_at
    expect(variant(a, uuid, 'es')!.rev).toBe(3);
    expect(historyOf(a, uuid, 'es')).toEqual([{ rev: 2, text: 'viejo', by: 'alice' }]);
  });

  it('keeps the destination’s when its rev is higher, retaining the source’s', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, { uuid, variants: [{ lang: 'es', text: 'nuevo', rev: 3 }] });
    put(b, { uuid, variants: [{ lang: 'es', text: 'viejo', rev: 2 }] });
    b.close();
    const result = mergeTm(a, path('b'), { actor: alice });
    expect(result).toMatchObject({ variantsKept: 1, historyRetained: 1 });
    expect(tokensOf(a, uuid, 'es')).toBe('nuevo');
    expect(historyOf(a, uuid, 'es')).toEqual([{ rev: 2, text: 'viejo', by: 'alice' }]);
  });

  it('retains nothing when the loser is the same content: there is nothing in it to keep', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, { uuid, variants: [{ lang: 'es', text: 'igual', rev: 2, updatedAt: T1 }] });
    put(b, { uuid, variants: [{ lang: 'es', text: 'igual', rev: 2, updatedAt: T2 }] });
    b.close();
    const result = mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(result).toMatchObject({
      variantsReplaced: 0,
      variantsKept: 0,
      historyRetained: 0,
    });
    expect(historyOf(a, uuid, 'es')).toEqual([]);
    expect(variant(a, uuid, 'es')!.updated_at).toBe(T2); // the later stamp is the winner's
  });

  describe('two copies each edited once from one ancestor — the same rev, different content', () => {
    function diverged(destinationLater: boolean) {
      const a = memory('a');
      const b = memory('b');
      const uuid = uid();
      put(a, {
        uuid,
        variants: [
          { lang: 'en', text: 'Cancel' },
          { lang: 'es', text: 'Anular', rev: 2, updatedAt: destinationLater ? T2 : T1 },
        ],
      });
      put(b, {
        uuid,
        variants: [
          { lang: 'en', text: 'Cancel' },
          { lang: 'es', text: 'Cancelar', rev: 2, updatedAt: destinationLater ? T1 : T2 },
        ],
      });
      b.close();
      return { a, uuid };
    }

    it('the later updated_at wins, at the next rev, with the loser in history at the shared one', () => {
      const { a, uuid } = diverged(false); // the source is later
      const result = mergeTm(a, path('b'), { actor: alice });
      expect(result).toMatchObject({ variantsReplaced: 1, historyRetained: 1 });
      expect(tokensOf(a, uuid, 'es')).toBe('Cancelar');
      expect(variant(a, uuid, 'es')!.rev).toBe(3);
      expect(historyOf(a, uuid, 'es')).toEqual([{ rev: 2, text: 'Anular', by: 'alice' }]);
    });

    it('likewise when the destination is the later one', () => {
      const { a, uuid } = diverged(true);
      mergeTm(a, path('b'), { actor: alice });
      expect(tokensOf(a, uuid, 'es')).toBe('Anular');
      expect(variant(a, uuid, 'es')!.rev).toBe(3);
      expect(historyOf(a, uuid, 'es')).toEqual([
        { rev: 2, text: 'Cancelar', by: 'alice' },
      ]);
    });

    it('lets the next edit through: writeBack retains into the slot after the loser’s, not onto it', () => {
      const { a, uuid } = diverged(false);
      mergeTm(a, path('b'), { actor: alice });
      // Confirming the same source again with another target is a normal edit.
      expect(() =>
        writeBack(a, {
          source: { lang: 'en', tokens: text('Cancel') },
          target: {
            lang: 'es',
            tokens: [
              { t: 'text', v: 'Anular el pedido' },
              { t: 'ph', id: 1, k: 'other' } as TmToken,
            ],
          },
        }),
      ).not.toThrow();
      expect(historyOf(a, uuid, 'es').map((h) => [h.rev, h.text])).toEqual([
        [2, 'Anular'],
        [3, 'Cancelar'],
      ]);
      expect(variant(a, uuid, 'es')!.rev).toBe(4);
    });

    it('chooses the same winner whichever memory is the destination, even on equal stamps', () => {
      const build = (name: string, translation: string) => {
        const m = memory(name);
        put(m, {
          uuid: 'fixed-uuid',
          variants: [{ lang: 'es', text: translation, rev: 2, updatedAt: T1 }],
        });
        m.close();
      };
      build('a', 'Anular');
      build('b', 'Cancelar');
      // Two independent merges, each from the other's pristine file.
      copyFileSync(path('a'), path('a-pristine'));
      copyFileSync(path('b'), path('b-pristine'));
      const intoA = reopen('a');
      const intoB = reopen('b');
      mergeTm(intoA, path('b-pristine'), { actor: TEST_ACTOR });
      mergeTm(intoB, path('a-pristine'), { actor: TEST_ACTOR });
      expect(tokensOf(intoA, 'fixed-uuid', 'es')).toBe(
        tokensOf(intoB, 'fixed-uuid', 'es'),
      );
      expect(variant(intoA, 'fixed-uuid', 'es')!.rev).toBe(
        variant(intoB, 'fixed-uuid', 'es')!.rev,
      );
    });
  });
});

describe('tombstones', () => {
  it('propagate: a unit the source deleted is deleted here, and stops being retrieved', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, {
      uuid,
      variants: [
        { lang: 'en', text: 'Old' },
        { lang: 'es', text: 'Viejo' },
      ],
    });
    put(b, {
      uuid,
      deleted: true,
      rev: 2,
      updatedAt: T1,
      variants: [
        { lang: 'en', text: 'Old' },
        { lang: 'es', text: 'Viejo' },
      ],
    });
    b.close();
    const result = mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(result.tombstonesPropagated).toBe(1);
    expect(dump(a).units[0]).toMatchObject({ deleted: 1, rev: 2, updated_at: T1 });
    expect(
      retrievePair(a, { srcLang: 'en', srcHash: hashOf('Old'), tgtLang: 'es' }),
    ).toEqual([]);
  });

  it('never resurrect: a live source cannot undelete what the destination deleted', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, { uuid, deleted: true, rev: 2, variants: [{ lang: 'en', text: 'Old' }] });
    put(b, { uuid, variants: [{ lang: 'en', text: 'Old', rev: 5, updatedAt: T2 }] });
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(dump(a).units[0]).toMatchObject({ deleted: 1 });
  });

  it('are copied with a unit the destination never had', () => {
    const a = memory('a');
    const b = memory('b');
    put(b, { uuid: uid(), deleted: true, variants: [{ lang: 'en', text: 'Gone' }] });
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(dump(a).units[0]).toMatchObject({ deleted: 1 });
    expect(a.prepare('SELECT COUNT(*) AS n FROM tuv').get()).toEqual({ n: 1 });
  });
});

describe('unit attributes', () => {
  it('are the union of keys; where both have one, the unit with the higher rev wins', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, {
      uuid,
      rev: 1,
      attrs: { client: 'acme', domain: 'legal' },
      variants: [{ lang: 'en', text: 'x' }],
    });
    put(b, {
      uuid,
      rev: 2,
      attrs: { client: 'globex', subject: 'tax' },
      variants: [{ lang: 'en', text: 'x' }],
    });
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(dump(a).attrs.map((r) => `${r.key}=${r.value}`)).toEqual([
      'client=globex',
      'domain=legal',
      'subject=tax',
    ]);
  });

  it('keep the destination’s value when its unit is the higher rev', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, {
      uuid,
      rev: 3,
      attrs: { client: 'acme' },
      variants: [{ lang: 'en', text: 'x' }],
    });
    put(b, {
      uuid,
      rev: 2,
      attrs: { client: 'globex' },
      variants: [{ lang: 'en', text: 'x' }],
    });
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(dump(a).attrs).toEqual([{ uuid, key: 'client', value: 'acme' }]);
  });
});

describe('what does not depend on who won', () => {
  it('takes the larger usage count and the later last_used_at, so a re-merge does not double them', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, { uuid, variants: [{ lang: 'es', text: 'x', usage: 5 }] });
    put(b, { uuid, variants: [{ lang: 'es', text: 'x', usage: 8 }] });
    b.prepare(`UPDATE tuv SET last_used_at = ?`).run(T2);
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(variant(a, uuid, 'es')).toMatchObject({ usage_count: 8, last_used_at: T2 });
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(variant(a, uuid, 'es')).toMatchObject({ usage_count: 8, last_used_at: T2 });
  });
});

describe('derived data', () => {
  const vector = (db: Database.Database) =>
    (db.prepare('SELECT COUNT(*) AS n FROM tuv_vec').get() as { n: number }).n;
  const addVector = (db: Database.Database, uuid: string) =>
    db
      .prepare(
        `INSERT INTO tuv_vec (tuv_id, model, dim, vec)
         SELECT v.id, 'm', 1, x'00000000' FROM tuv v JOIN tu u ON u.id = v.tu_id WHERE u.uuid = ?`,
      )
      .run(uuid);

  it('drops a vector when the source wins with other text (§2.8.3), and keeps it otherwise', () => {
    const a = memory('a');
    const b = memory('b');
    const [replaced, kept] = [uid(), uid()];
    put(a, { uuid: replaced, variants: [{ lang: 'es', text: 'viejo', rev: 1 }] });
    put(a, { uuid: kept, variants: [{ lang: 'es', text: 'firme', rev: 2 }] });
    addVector(a, replaced);
    addVector(a, kept);
    put(b, { uuid: replaced, variants: [{ lang: 'es', text: 'nuevo', rev: 2 }] });
    put(b, { uuid: kept, variants: [{ lang: 'es', text: 'otro', rev: 1 }] });
    b.close();
    expect(vector(a)).toBe(2);
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(vector(a)).toBe(1);
    const left = a
      .prepare(
        'SELECT u.uuid AS uuid FROM tuv_vec x JOIN tuv v ON v.id = x.tuv_id JOIN tu u ON u.id = v.tu_id',
      )
      .all();
    expect(left).toEqual([{ uuid: kept }]);
  });

  it('copies no vector across: they are recomputable, and of the source’s model', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(b, { uuid, variants: [{ lang: 'es', text: 'x' }] });
    addVector(b, uuid);
    b.close();
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(vector(a)).toBe(0);
  });

  it('copies segmentation rules for a language the destination lacks, and says when they clash', () => {
    const a = memory('a');
    const b = memory('b');
    a.prepare(`INSERT INTO seg_profile (lang, delta) VALUES ('en', '{"v":"a"}')`).run();
    b.prepare(
      `INSERT INTO seg_profile (lang, delta) VALUES ('en', '{"v":"b"}'), ('es', '{"v":"s"}')`,
    ).run();
    b.close();
    const result = mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(a.prepare('SELECT lang, delta FROM seg_profile ORDER BY lang').all()).toEqual([
      { lang: 'en', delta: '{"v":"a"}' },
      { lang: 'es', delta: '{"v":"s"}' },
    ]);
    expect(result.warnings).toEqual([
      'segmentation rules for "en" differ between the two memories; the destination\'s were kept',
    ]);
  });
});

describe('history', () => {
  it('copies the source’s own history for variants that lined up', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, {
      uuid,
      variants: [
        {
          lang: 'es',
          text: 'v3',
          rev: 3,
          history: [
            { rev: 1, text: 'v1' },
            { rev: 2, text: 'v2' },
          ],
        },
      ],
    });
    put(b, {
      uuid,
      variants: [
        {
          lang: 'es',
          text: 'v4',
          rev: 4,
          history: [
            { rev: 1, text: 'v1' },
            { rev: 2, text: 'v2' },
            { rev: 3, text: 'v3' },
          ],
        },
      ],
    });
    b.close();
    const result = mergeTm(a, path('b'), { actor: alice });
    expect(result.historyConflicts).toBe(0);
    // the source won; our v3 was retained, and it already sat in the source's history
    expect(historyOf(a, uuid, 'es').map((h) => [h.rev, h.text])).toEqual([
      [1, 'v1'],
      [2, 'v2'],
      [3, 'v3'],
    ]);
    expect(variant(a, uuid, 'es')!.rev).toBe(4);
  });

  it('says so when two diverged lineages want one slot, keeps the destination’s, and leaves the source whole', () => {
    // A went 1→2→3 and B went 1→2′; both passed through rev 2 with other text.
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, {
      uuid,
      variants: [
        {
          lang: 'es',
          text: 'a3',
          rev: 3,
          history: [
            { rev: 1, text: 'a1' },
            { rev: 2, text: 'a2' },
          ],
        },
      ],
    });
    put(b, {
      uuid,
      variants: [{ lang: 'es', text: 'b2', rev: 2, history: [{ rev: 1, text: 'a1' }] }],
    });
    b.close();
    const sourceBefore = digest(path('b'));
    const result = mergeTm(a, path('b'), { actor: alice });
    expect(result).toMatchObject({
      variantsKept: 1,
      historyRetained: 0,
      historyConflicts: 1,
    });
    expect(historyOf(a, uuid, 'es').map((h) => [h.rev, h.text])).toEqual([
      [1, 'a1'],
      [2, 'a2'],
    ]);
    expect(tokensOf(a, uuid, 'es')).toBe('a3');
    a.close();
    expect(digest(path('b'))).toBe(sourceBefore);
  });
});

describe('commutativity and idempotence on a corpus', () => {
  /** Two copies of one memory that were each worked on, plus what only one of them has. */
  function corpus() {
    const [shared, edited, tied, deleted, onlyA, onlyB, attrs] = [
      uid(),
      uid(),
      uid(),
      uid(),
      uid(),
      uid(),
      uid(),
    ];
    const both: UnitSpec[] = [
      {
        uuid: shared,
        variants: [
          { lang: 'en', text: 'Open' },
          { lang: 'es', text: 'Abrir' },
        ],
      },
      {
        uuid: edited,
        variants: [
          { lang: 'en', text: 'Close' },
          { lang: 'es', text: 'Cerrar', rev: 2, history: [{ rev: 1, text: 'Cierre' }] },
        ],
      },
      {
        uuid: tied,
        variants: [
          { lang: 'en', text: 'Print' },
          {
            lang: 'es',
            text: 'Imprimir',
            rev: 2,
            history: [{ rev: 1, text: 'Impresión' }],
          },
        ],
      },
      {
        uuid: deleted,
        variants: [
          { lang: 'en', text: 'Old' },
          { lang: 'es', text: 'Antiguo' },
        ],
      },
      {
        uuid: attrs,
        rev: 1,
        attrs: { client: 'acme' },
        variants: [{ lang: 'en', text: 'Save' }],
      },
    ];
    const a = memory('a');
    const b = memory('b');
    for (const u of both) {
      put(a, u);
      put(b, u);
    }
    // A worked on one thing, B on another, both on one.
    // The history row is the text the variant has *now*; then the edit.
    a.prepare(
      `INSERT INTO tuv_history (tuv_id, rev, tokens, quality, changed_at) SELECT id, 2, tokens, 2, ? FROM tuv WHERE tu_id = (SELECT id FROM tu WHERE uuid = ?) AND lang = 'es'`,
    ).run(T1, edited);
    a.prepare(
      `UPDATE tuv SET rev = 3, tokens = ?, plain = 'cerrar el archivo', hash = ?, updated_at = ? WHERE lang = 'es' AND tu_id = (SELECT id FROM tu WHERE uuid = ?)`,
    ).run(
      JSON.stringify(text('Cerrar el archivo')),
      hashOf('Cerrar el archivo'),
      T1,
      edited,
    );
    for (const [db, translation, when] of [
      [a, 'Imprimir ahora', T1],
      [b, 'Imprimir esto', T2],
    ] as const) {
      db.prepare(
        `UPDATE tuv SET rev = 3, tokens = ?, plain = ?, hash = ?, updated_at = ? WHERE lang = 'es' AND tu_id = (SELECT id FROM tu WHERE uuid = ?)`,
      ).run(
        JSON.stringify(text(translation)),
        translation.toLowerCase(),
        hashOf(translation),
        when,
        tied,
      );
      db.prepare(
        `INSERT INTO tuv_history (tuv_id, rev, tokens, quality, changed_at) SELECT id, 2, ?, 2, ? FROM tuv WHERE tu_id = (SELECT id FROM tu WHERE uuid = ?) AND lang = 'es'`,
      ).run(JSON.stringify(text('Imprimir')), when, tied);
    }
    b.prepare('UPDATE tu SET deleted = 1, rev = 2, updated_at = ? WHERE uuid = ?').run(
      T1,
      deleted,
    );
    b.prepare(`UPDATE tu SET rev = 2 WHERE uuid = ?`).run(attrs);
    b.prepare(
      `UPDATE tu_attr SET value = 'globex' WHERE tu_id = (SELECT id FROM tu WHERE uuid = ?)`,
    ).run(attrs);
    b.prepare(
      `UPDATE tuv SET usage_count = 9, last_used_at = ? WHERE tu_id = (SELECT id FROM tu WHERE uuid = ?)`,
    ).run(T2, shared);
    put(a, {
      uuid: onlyA,
      variants: [
        { lang: 'en', text: 'Only A' },
        { lang: 'fr', text: 'Seulement A' },
      ],
    });
    put(b, {
      uuid: onlyB,
      variants: [
        { lang: 'en', text: 'Only B' },
        { lang: 'de', text: 'Nur B' },
      ],
    });
    return { a, b, ids: { shared, edited, tied, deleted, onlyA, onlyB, attrs } };
  }

  it('merging A into B and B into A gives the same memory, up to the stamp of the merge itself', () => {
    const { a, b } = corpus();
    a.close();
    b.close();
    copyFileSync(path('a'), path('a2'));
    copyFileSync(path('b'), path('b2'));
    const intoA = reopen('a');
    const intoB = reopen('b2');
    const r1 = mergeTm(intoA, path('b'), { actor: alice });
    // from the pristine copies: path('a') is already merged into
    const r2 = mergeTm(intoB, path('a2'), { actor: alice });

    expect(r1.historyConflicts).toBe(0);
    expect(r2.historyConflicts).toBe(0);
    expect(dump(intoA, false)).toEqual(dump(intoB, false));
    // and it is the whole corpus, not an empty tie
    expect(dump(intoA).units).toHaveLength(7);
    expect(dump(intoA).langs).toEqual(['de', 'en', 'es', 'fr']);
  });

  it('merging again changes nothing, from either side', () => {
    const { a, b } = corpus();
    a.close();
    b.close();
    const intoA = reopen('a');
    mergeTm(intoA, path('b'), { actor: alice });
    const once = dump(intoA);
    expect(mergeTm(intoA, path('b'), { actor: alice })).toMatchObject({
      unitsAdded: 0,
      tombstonesPropagated: 0,
      variantsAdded: 0,
      historyRetained: 0,
      historyConflicts: 0,
    });
    expect(dump(intoA)).toEqual(once);
  });

  it('resolves each unit as the rules say', () => {
    const { a, b, ids } = corpus();
    b.close();
    mergeTm(a, path('b'), { actor: alice });
    expect(tokensOf(a, ids.edited, 'es')).toBe('Cerrar el archivo'); // A's rev 3 over B's rev 2
    expect(tokensOf(a, ids.tied, 'es')).toBe('Imprimir esto'); // equal rev, B's stamp later
    expect(variant(a, ids.tied, 'es')!.rev).toBe(4);
    expect(dump(a).units.find((u) => u.uuid === ids.deleted)).toMatchObject({
      deleted: 1,
    });
    expect(dump(a).attrs.find((r) => r.uuid === ids.attrs)).toMatchObject({
      value: 'globex',
    });
    expect(variant(a, ids.shared, 'en')).toMatchObject({ usage_count: 9 });
    expect(a.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 7 });
  });
});

describe('what a merge refuses, and how it fails', () => {
  it('never writes the source', () => {
    const a = memory('a');
    const b = memory('b');
    put(b, { uuid: uid(), variants: [{ lang: 'en', text: 'x' }] });
    b.close();
    const before = digest(path('b'));
    mergeTm(a, path('b'), { actor: TEST_ACTOR });
    expect(digest(path('b'))).toBe(before);
    expect(existsSync(`${path('b')}-wal`)).toBe(false);
  });

  it('refuses a source that does not exist, without creating it', () => {
    const a = memory('a');
    expect(() => mergeTm(a, path('missing'), { actor: TEST_ACTOR })).toThrow(
      /no memory at/,
    );
    expect(existsSync(path('missing'))).toBe(false);
  });

  it('refuses a file that is not a .ctm', () => {
    const a = memory('a');
    writeFileSync(path('text'), 'this is not a database, at all, not even close');
    expect(() => mergeTm(a, path('text'), { actor: TEST_ACTOR })).toThrow(/not a \.ctm/);
    const other = memory('other');
    other.pragma('application_id = 12345');
    other.close();
    expect(() => mergeTm(a, path('other'), { actor: TEST_ACTOR })).toThrow(/not a \.ctm/);
    // …and the connection is still usable, with nothing left attached
    expect(() => mergeTm(a, path('a'), { actor: TEST_ACTOR })).not.toThrow();
  });

  it('refuses a memory in a newer format than this build understands', () => {
    const a = memory('a');
    const b = memory('b');
    b.pragma('user_version = 99');
    b.close();
    expect(() => mergeTm(a, path('b'), { actor: TEST_ACTOR })).toThrow(/newer than/);
  });

  it('refuses a memory hashed under another normalizer, and writes nothing', () => {
    const a = memory('a');
    const b = memory('b');
    put(b, { uuid: uid(), variants: [{ lang: 'en', text: 'x' }] });
    b.prepare('UPDATE tm SET normalizer_version = 99').run();
    b.close();
    const before = dump(a);
    expect(() => mergeTm(a, path('b'), { actor: TEST_ACTOR })).toThrow(
      /normalizer_version 99/,
    );
    expect(dump(a)).toEqual(before);
  });

  it('refuses a read-only destination', () => {
    const a = memory('a');
    const b = memory('b');
    b.close();
    a.prepare('UPDATE tm SET read_only = 1').run();
    expect(() => mergeTm(a, path('b'), { actor: TEST_ACTOR })).toThrow(/read-only/);
  });

  it('is all or nothing: a failure part-way leaves the destination as it was, and the connection usable', () => {
    const a = memory('a');
    const b = memory('b');
    const uuid = uid();
    put(a, { uuid, variants: [{ lang: 'es', text: 'viejo', rev: 1 }] });
    put(b, { uuid, variants: [{ lang: 'es', text: 'nuevo', rev: 2 }] });
    put(b, { uuid: uid(), variants: [{ lang: 'en', text: 'added' }] });
    b.close();
    const before = dump(a);
    a.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON tuv_history BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => mergeTm(a, path('b'), { actor: TEST_ACTOR })).toThrow(/boom/);
    expect(dump(a)).toEqual(before);
    a.exec('DROP TRIGGER boom');
    // nothing stale is left behind: the same merge now runs clean
    expect(mergeTm(a, path('b'), { actor: TEST_ACTOR })).toMatchObject({
      unitsAdded: 1,
      variantsReplaced: 1,
    });
    expect(TM_APPLICATION_ID).toBe(0x4341544d);
  });
});
