import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashOf } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTm } from './index.js';
import { importTmx, importTmxFile, listTmImports } from './import-tmx.js';
import { retrievePair } from './retrieve.js';

const dirs: string[] = [];
const opened: Database.Database[] = [];

/** A fresh `.ctm` in its own temp directory, both cleaned up afterwards. */
function newTm(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'cat-import-tmx-'));
  dirs.push(dir);
  const db = createTm(join(dir, 'memory.ctm'), { name: 'x', generator: 'test' });
  opened.push(db);
  return db;
}

// The handles are what changed here: they were never closed, and Windows
// cannot unlink an open file, so `rmSync` can throw EBUSY — which is
// precisely how the sibling `.sdltm` suite failed CI on Windows alone while
// passing everywhere else. This suite happened to stay green there, but on
// timing rather than on anything it guaranteed, and a test that depends on a
// connection being finalized at the right moment is a flake waiting for a
// slower runner. (The directories were already being removed correctly:
// exactly one `.ctm` per test, so the single reassigned `dir` was always the
// current one. Tracking them in a list is for the next test that wants two.)
afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test itself; nothing to do.
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/** A minimal but structurally realistic TMX 1.4b document, Trados-shaped. */
function tmx(bodyInner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
<header srclang="en" adminlang="en" o-tmf="TW4" datatype="plaintext" segtype="sentence"/>
<body>
${bodyInner}
</body>
</tmx>`;
}

describe('importTmx', () => {
  it('imports a Trados-shaped bilingual TMX with correct TU/TUV counts and tags intact', () => {
    const db = newTm();
    const result = importTmx(
      db,
      tmx(`
<tu tuid="1" creationdate="20260101T120000Z" creationid="alice">
  <tuv xml:lang="en"><seg>Click <bpt i="1" x="1">&lt;b&gt;</bpt>here<ept i="1">&lt;/b&gt;</ept> to continue.</seg></tuv>
  <tuv xml:lang="es"><seg>Haga clic <bpt i="1" x="1">&lt;b&gt;</bpt>aquí<ept i="1">&lt;/b&gt;</ept> para continuar.</seg></tuv>
</tu>
<tu tuid="2">
  <tuv xml:lang="en"><seg>Save changes</seg></tuv>
  <tuv xml:lang="es"><seg>Guardar cambios</seg></tuv>
</tu>`),
    );
    expect(result.tuCount).toBe(2);
    expect(result.tuvCount).toBe(4);

    const rows = db.prepare('SELECT lang, tokens FROM tuv ORDER BY id').all() as Array<{
      lang: string;
      tokens: string;
    }>;
    expect(rows).toHaveLength(4);
    const firstTokens = JSON.parse(rows[0]!.tokens);
    expect(firstTokens).toEqual([
      { t: 'text', v: 'Click ' },
      { t: 'open', id: 1 },
      { t: 'text', v: 'here' },
      { t: 'close', id: 1 },
      { t: 'text', v: ' to continue.' },
    ]);
    db.close();
  });

  it('is retrievable via retrievePair immediately after import', () => {
    const db = newTm();
    importTmx(
      db,
      tmx(`
<tu>
  <tuv xml:lang="en"><seg>Save changes</seg></tuv>
  <tuv xml:lang="es"><seg>Guardar cambios</seg></tuv>
</tu>`),
    );
    const matches = retrievePair(db, {
      srcLang: 'en',
      srcHash: hashOf('Save changes'),
      tgtLang: 'es',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tokens).toEqual([{ t: 'text', v: 'Guardar cambios' }]);
    db.close();
  });

  it('imports a multilingual TMX whole — one tuv per language, not flattened to a pair', () => {
    const db = newTm();
    const result = importTmx(
      db,
      tmx(`
<tu>
  <tuv xml:lang="en"><seg>Save</seg></tuv>
  <tuv xml:lang="es"><seg>Guardar</seg></tuv>
  <tuv xml:lang="de"><seg>Speichern</seg></tuv>
</tu>`),
    );
    expect(result.tuvCount).toBe(3);
    const langs = db.prepare('SELECT DISTINCT lang FROM tuv ORDER BY lang').all();
    expect(langs).toEqual([{ lang: 'de' }, { lang: 'en' }, { lang: 'es' }]);
    db.close();
  });

  it('updates tm.langs to the union of languages actually present', () => {
    const db = newTm();
    importTmx(
      db,
      tmx(`
<tu><tuv xml:lang="en"><seg>Hi</seg></tuv><tuv xml:lang="fr"><seg>Salut</seg></tuv></tu>`),
    );
    const tm = db.prepare('SELECT langs FROM tm').get() as { langs: string };
    expect(JSON.parse(tm.langs)).toEqual(['en', 'fr']);
    db.close();
  });

  it('defaults quality to 2 (confirmed) — TMX carries no quality signal', () => {
    const db = newTm();
    importTmx(db, tmx('<tu><tuv xml:lang="en"><seg>Hi</seg></tuv></tu>'));
    const row = db.prepare('SELECT quality FROM tuv').get() as { quality: number };
    expect(row.quality).toBe(2);
    db.close();
  });

  it('maps usagecount/lastusagedate from <tu> onto every variant when <tuv> has none of its own', () => {
    const db = newTm();
    importTmx(
      db,
      tmx(`
<tu usagecount="104" lastusagedate="20260203T063233Z">
  <tuv xml:lang="en"><seg>Hi</seg></tuv>
  <tuv xml:lang="es"><seg>Hola</seg></tuv>
</tu>`),
    );
    const rows = db
      .prepare('SELECT lang, usage_count, last_used_at FROM tuv ORDER BY lang')
      .all();
    expect(rows).toEqual([
      { lang: 'en', usage_count: 104, last_used_at: '2026-02-03T06:32:33.000Z' },
      { lang: 'es', usage_count: 104, last_used_at: '2026-02-03T06:32:33.000Z' },
    ]);
    db.close();
  });

  it("prefers a <tuv>'s own usagecount/lastusagedate over the unit's", () => {
    const db = newTm();
    importTmx(
      db,
      tmx(`
<tu usagecount="104" lastusagedate="20260203T063233Z">
  <tuv xml:lang="en" usagecount="9" lastusagedate="20260101T000000Z"><seg>Hi</seg></tuv>
</tu>`),
    );
    const row = db.prepare('SELECT usage_count, last_used_at FROM tuv').get();
    expect(row).toEqual({ usage_count: 9, last_used_at: '2026-01-01T00:00:00.000Z' });
    db.close();
  });

  it('defaults usage_count to 0 and last_used_at to NULL when neither TMX level has it', () => {
    const db = newTm();
    importTmx(db, tmx('<tu><tuv xml:lang="en"><seg>Hi</seg></tuv></tu>'));
    const row = db.prepare('SELECT usage_count, last_used_at FROM tuv').get();
    expect(row).toEqual({ usage_count: 0, last_used_at: null });
    db.close();
  });

  it('warns rather than silently dropping data when a real-world <tu> repeats a prop type', () => {
    const db = newTm();
    const result = importTmx(
      db,
      tmx(`
<tu>
  <prop type="x-Context">0, 0</prop>
  <prop type="x-Context">1, 1</prop>
  <tuv xml:lang="en"><seg>Hi</seg></tuv>
</tu>`),
    );
    expect(result.warnings.some((w) => w.includes('x-Context'))).toBe(true);
    // Deterministic (last value), just no longer silent about it.
    const attr = db
      .prepare("SELECT value FROM tu_attr WHERE key = 'x-Context'")
      .get() as {
      value: string;
    };
    expect(attr.value).toBe('1, 1');
    db.close();
  });

  it('leaves prev_hash/next_hash NULL for an ordinary TMX and warns once that units can never be ICE matches', () => {
    const db = newTm();
    const result = importTmx(
      db,
      tmx(`
<tu><tuv xml:lang="en"><seg>Hi</seg></tuv></tu>
<tu><tuv xml:lang="en"><seg>Bye</seg></tuv></tu>`),
    );
    const rows = db.prepare('SELECT prev_hash, next_hash FROM tuv').all() as Array<{
      prev_hash: string | null;
      next_hash: string | null;
    }>;
    expect(rows.every((r) => r.prev_hash === null && r.next_hash === null)).toBe(true);
    const iceWarnings = result.warnings.filter((w) => w.includes('ICE'));
    expect(iceWarnings).toHaveLength(1);
    db.close();
  });

  it('preserves tuid in tu_attr and maps a generic <prop> through', () => {
    const db = newTm();
    importTmx(
      db,
      tmx(`
<tu tuid="unit-42">
  <prop type="x-context">a button label</prop>
  <tuv xml:lang="en"><seg>OK</seg></tuv>
</tu>`),
    );
    const attrs = db.prepare('SELECT key, value FROM tu_attr ORDER BY key').all();
    expect(attrs).toEqual([
      { key: 'tuid', value: 'unit-42' },
      { key: 'x-context', value: 'a button label' },
    ]);
    db.close();
  });

  it('restores uuid, rev, quality and context from our own previously-exported x-catm-* props', () => {
    const db = newTm();
    importTmx(
      db,
      tmx(`
<tu>
  <prop type="x-catm-uuid">aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa</prop>
  <prop type="x-catm-rev">4</prop>
  <tuv xml:lang="es">
    <prop type="x-catm-quality">3</prop>
    <prop type="x-catm-prev">prev-hash-value</prop>
    <prop type="x-catm-next">next-hash-value</prop>
    <seg>Guardar</seg>
  </tuv>
</tu>`),
    );
    const tu = db.prepare('SELECT uuid, rev FROM tu').get() as {
      uuid: string;
      rev: number;
    };
    expect(tu.uuid).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(tu.rev).toBe(4);
    const tuv = db.prepare('SELECT quality, prev_hash, next_hash FROM tuv').get() as {
      quality: number;
      prev_hash: string;
      next_hash: string;
    };
    expect(tuv).toEqual({
      quality: 3,
      prev_hash: 'prev-hash-value',
      next_hash: 'next-hash-value',
    });
    // Restored x-catm-* props are not also written as ordinary tu_attr rows.
    expect(db.prepare('SELECT COUNT(*) AS n FROM tu_attr').get()).toEqual({ n: 0 });
    db.close();
  });

  it('falls back to a fresh uuid, with a warning, when a restored x-catm-uuid collides', () => {
    const db = newTm();
    const doc = tmx(`
<tu>
  <prop type="x-catm-uuid">bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb</prop>
  <tuv xml:lang="en"><seg>First</seg></tuv>
</tu>`);
    importTmx(db, doc);
    const result = importTmx(
      db,
      tmx(`
<tu tuid="dup">
  <prop type="x-catm-uuid">bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb</prop>
  <tuv xml:lang="en"><seg>Second</seg></tuv>
</tu>`),
    );
    const uuids = db.prepare('SELECT uuid FROM tu ORDER BY id').all() as Array<{
      uuid: string;
    }>;
    expect(uuids).toHaveLength(2);
    expect(uuids[0]!.uuid).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(uuids[1]!.uuid).not.toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(result.warnings.some((w) => w.includes('reuses uuid'))).toBe(true);
    db.close();
  });

  it('converts TMX dates to ISO 8601 for created_at/updated_at', () => {
    const db = newTm();
    importTmx(
      db,
      tmx(`
<tu creationdate="20260315T093000Z" changedate="20260401T000000Z" creationid="bob">
  <tuv xml:lang="en"><seg>Hi</seg></tuv>
</tu>`),
    );
    const tu = db.prepare('SELECT created_at, updated_at, created_by FROM tu').get() as {
      created_at: string;
      updated_at: string;
      created_by: string;
    };
    expect(tu.created_at).toBe('2026-03-15T09:30:00.000Z');
    expect(tu.updated_at).toBe('2026-04-01T00:00:00.000Z');
    expect(tu.created_by).toBe('bob');
    db.close();
  });

  it('runs as a single transaction — a structurally invalid TMX leaves the memory untouched', () => {
    const db = newTm();
    expect(() => importTmx(db, '<notTmx/>')).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('importTmxFile (backlog #18c)', () => {
  /** Writes `text` beside a fresh memory; returns both. */
  function withFile(text: string): { db: Database.Database; path: string } {
    const db = newTm();
    const path = join(dirs[dirs.length - 1]!, 'memory.tmx');
    writeFileSync(path, text, 'utf8');
    return { db, path };
  }

  const unit = (n: number, fr = `Bonjour ${n}`): string =>
    `<tu tuid="${n}"><tuv xml:lang="en"><seg>Hello ${n}</seg></tuv>` +
    `<tuv xml:lang="fr"><seg>${fr}</seg></tuv></tu>`;

  /** Every unit's (tuid, lang, plain), in insertion order — what an import is judged by. */
  function contents(db: Database.Database): unknown[] {
    return db
      .prepare(
        `SELECT a.value AS tuid, v.lang, v.plain FROM tuv v
         JOIN tu_attr a ON a.tu_id = v.tu_id AND a.key = 'tuid'
         ORDER BY v.tu_id, v.lang`,
      )
      .all();
  }

  it('writes in batches exactly what a single-transaction import writes', () => {
    const doc = tmx([1, 2, 3, 4, 5].map((n) => unit(n)).join('\n'));
    const { db, path } = withFile(doc);
    const result = importTmxFile(db, path, { batchSize: 2 });
    expect(result).toMatchObject({ tuCount: 5, tuvCount: 10 });

    const reference = newTm();
    importTmx(reference, doc);
    expect(contents(db)).toEqual(contents(reference));
    expect(
      JSON.parse((db.prepare('SELECT langs FROM tm').get() as { langs: string }).langs),
    ).toEqual(['en', 'fr']);

    const [run] = listTmImports(db);
    expect(run).toMatchObject({
      id: result.importId,
      format: 'tmx',
      sourceName: 'memory.tmx',
      unitsDone: 5,
      variantsDone: 10,
    });
    expect(run!.finishedAt).not.toBeNull();
  });

  it('decodes a multi-byte character split across chunk boundaries', () => {
    const text = 'caf\u00E9 \u65E5\u672C\u8A9E \u{1F600}';
    const { db, path } = withFile(tmx(unit(1, text)));
    for (const chunkBytes of [1, 2, 3, 5, 7]) {
      const target = newTm();
      importTmxFile(target, path, { chunkBytes });
      expect(contents(target), `chunkBytes ${chunkBytes}`).toContainEqual({
        tuid: '1',
        lang: 'fr',
        plain: text,
      });
    }
    db.close();
  });

  it('keeps whole committed batches when a later unit is malformed, and resumes after them', () => {
    // Unit 4 has an <ept> with no <bpt>: a TmxError at parse time. The
    // fix is the same length, so the resumed file passes the size guard.
    const bad = unit(4, 'Bon<ept i="9"/>jour 4');
    const good = unit(4, 'Bon<ph x="99"/>jour 4');
    expect(good.length).toBe(bad.length);
    const units = [1, 2, 3, 4, 5].map((n) => unit(n));
    const { db, path } = withFile(tmx([...units.slice(0, 3), bad, units[4]].join('\n')));

    // Small chunks, so units 1-3 arrive before the bad one does, as they
    // would in a real multi-megabyte file; a unit is only ever committed
    // once its batch fills, whatever chunk it came in.
    expect(() => importTmxFile(db, path, { batchSize: 2, chunkBytes: 64 })).toThrow(
      /no matching <bpt>/,
    );
    const [interrupted] = listTmImports(db);
    expect(interrupted).toMatchObject({
      unitsDone: 2,
      variantsDone: 4,
      finishedAt: null,
    });
    expect(contents(db)).toHaveLength(4); // units 1 and 2 only: unit 3 was never committed

    writeFileSync(path, tmx([...units.slice(0, 3), good, units[4]].join('\n')), 'utf8');
    const resumed = importTmxFile(db, path, { batchSize: 2, resume: interrupted!.id });
    expect(resumed).toMatchObject({ importId: interrupted!.id, tuCount: 3, tuvCount: 6 });
    expect(
      contents(db).filter((r) => (r as { lang: string }).lang === 'en'),
    ).toHaveLength(5);
    expect(listTmImports(db)).toEqual([
      expect.objectContaining({ id: interrupted!.id, unitsDone: 5, variantsDone: 10 }),
    ]);
    expect(listTmImports(db)[0]!.finishedAt).not.toBeNull();
  });

  it('refuses to resume a finished import, a missing one, or a different file', () => {
    const { db, path } = withFile(tmx(unit(1)));
    const done = importTmxFile(db, path);
    expect(() => importTmxFile(db, path, { resume: done.importId })).toThrow(
      /nothing to resume/,
    );
    expect(() => importTmxFile(db, path, { resume: 99 })).toThrow(/no import #99/);

    db.prepare('UPDATE tm_import SET finished_at = NULL, source_bytes = 1').run();
    expect(() => importTmxFile(db, path, { resume: done.importId })).toThrow(
      /not resumable/,
    );
  });

  it('records a string import as one finished run', () => {
    const db = newTm();
    const result = importTmx(db, tmx(unit(1)));
    expect(listTmImports(db)).toEqual([
      expect.objectContaining({ id: result.importId, unitsDone: 1, variantsDone: 2 }),
    ]);
    expect(listTmImports(db)[0]!.finishedAt).not.toBeNull();
  });
});
