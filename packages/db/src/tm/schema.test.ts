import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { MigrationError } from '../migrate.js';
import {
  createTm,
  openTm,
  TmError,
  TM_APPLICATION_ID,
  NORMALIZER_VERSION,
} from './index.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-tm-'));
  return join(dir, 'memory.ctm');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('createTm / openTm', () => {
  it('writes a single identity row', () => {
    const db = createTm(dbPath(), { name: 'EN-ES glossary', generator: 'cat-tool/test' });
    const tm = db.prepare('SELECT * FROM tm').get() as Record<string, unknown>;
    expect(tm['id']).toBe(1);
    expect(tm['name']).toBe('EN-ES glossary');
    expect(tm['langs']).toBe('[]');
    expect(typeof tm['uuid']).toBe('string');
    expect((tm['uuid'] as string).length).toBeGreaterThan(0);
    db.close();
  });

  it('stamps the real normalizer version (backlog #17) into every file it creates', () => {
    // Not a locally-declared constant coinciding with the rule set by
    // accident — imported from @cat-tool/core/tm/normalize.ts, the
    // module that actually implements normalizer_version = 1.
    expect(NORMALIZER_VERSION).toBe(1);
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const tm = db.prepare('SELECT normalizer_version FROM tm').get() as {
      normalizer_version: number;
    };
    expect(tm.normalizer_version).toBe(NORMALIZER_VERSION);
    db.close();
  });

  it('refuses to re-create an already-initialised file', () => {
    const path = dbPath();
    createTm(path, { name: 'first', generator: 'test' }).close();
    expect(() => createTm(path, { name: 'second', generator: 'test' })).toThrow(TmError);
  });

  it('openTm opens what createTm made, unchanged', () => {
    const path = dbPath();
    createTm(path, { name: 'roundtrip', generator: 'test' }).close();
    const db = openTm(path);
    expect((db.prepare('SELECT name FROM tm').get() as { name: string }).name).toBe(
      'roundtrip',
    );
    db.close();
  });

  it('creates every table the spec calls for', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
      // fts5's own shadow tables (_data, _idx, _docsize, _config) are an
      // implementation detail of the virtual table, not part of the schema.
      .filter((name) => !name.startsWith('tuv_fts_'));
    expect(tables).toEqual(
      [
        'seg_profile',
        'tm',
        'tu',
        'tu_attr',
        'tuv',
        'tuv_fts',
        'tuv_history',
        'tuv_vec',
      ].sort(),
    );
    db.close();
  });

  it('is identified as CATM by its raw file header alone', () => {
    const path = dbPath();
    createTm(path, { name: 'x', generator: 'test' }).close();
    // SQLite's application_id lives at byte offset 68, big-endian — this
    // reads it without going through SQLite at all (tm-format-spec.md §1).
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(68, false)).toBe(TM_APPLICATION_ID);
  });
});

describe('tu / tuv', () => {
  const insertUnit = (
    db: Database.Database,
    uuid: string,
    lang: string,
    plain: string,
  ): number => {
    const now = new Date().toISOString();
    const tu = db
      .prepare('INSERT INTO tu (uuid, created_at, updated_at) VALUES (?, ?, ?)')
      .run(uuid, now, now);
    db.prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
       VALUES (?, ?, '[]', ?, ?, ?, ?)`,
    ).run(tu.lastInsertRowid, lang, plain, `hash-of-${plain}`, now, now);
    return tu.lastInsertRowid as number;
  };

  it('one unit holds one variant per language, retrievable either direction', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const tuId = insertUnit(db, 'u1', 'en', 'Hello');
    db.prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
       VALUES (?, 'es', '[]', 'Hola', 'hash-of-Hola', ?, ?)`,
    ).run(tuId, new Date().toISOString(), new Date().toISOString());

    const enToEs = db
      .prepare(
        `SELECT t.plain FROM tuv s JOIN tuv t ON t.tu_id = s.tu_id AND t.lang = 'es'
         WHERE s.lang = 'en' AND s.hash = 'hash-of-Hello'`,
      )
      .get() as { plain: string };
    expect(enToEs.plain).toBe('Hola');

    const esToEn = db
      .prepare(
        `SELECT t.plain FROM tuv s JOIN tuv t ON t.tu_id = s.tu_id AND t.lang = 'en'
         WHERE s.lang = 'es' AND s.hash = 'hash-of-Hola'`,
      )
      .get() as { plain: string };
    expect(esToEn.plain).toBe('Hello');
    db.close();
  });

  it('enforces one variant per language per unit', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const tuId = insertUnit(db, 'u1', 'en', 'Hello');
    expect(() =>
      db
        .prepare(
          `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
           VALUES (?, 'en', '[]', 'Hello again', 'h2', ?, ?)`,
        )
        .run(tuId, new Date().toISOString(), new Date().toISOString()),
    ).toThrow();
    db.close();
  });

  it('deleting a unit cascades to its variants (foreign_keys enforced)', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const tuId = insertUnit(db, 'u1', 'en', 'Hello');
    expect((db.prepare('SELECT COUNT(*) AS n FROM tuv').get() as { n: number }).n).toBe(
      1,
    );
    db.prepare('DELETE FROM tu WHERE id = ?').run(tuId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM tuv').get() as { n: number }).n).toBe(
      0,
    );
    db.close();
  });

  it('two different units may share a hash in the same language (§7)', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    insertUnit(db, 'u1', 'en', 'Hello');
    insertUnit(db, 'u2', 'en', 'Hello');
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM tuv WHERE hash = 'hash-of-Hello'")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
    db.close();
  });
});

describe('format version guard (#15b)', () => {
  it('refuses a .ctm file hand-bumped to a future format version, rather than partially reading it', () => {
    const path = dbPath();
    createTm(path, { name: 'x', generator: 'test' }).close();
    const raw = new Database(path);
    raw.pragma('user_version = 999');
    raw.close();

    expect(() => openTm(path)).toThrow(MigrationError);
    expect(() => openTm(path)).toThrow(/newer than/);
  });
});

describe('tuv_fts', () => {
  it('stays in sync with tuv through insert, update, and delete', () => {
    const db = createTm(dbPath(), { name: 'x', generator: 'test' });
    const now = new Date().toISOString();
    const tu = db
      .prepare('INSERT INTO tu (uuid, created_at, updated_at) VALUES (?, ?, ?)')
      .run('u1', now, now);
    const tuv = db
      .prepare(
        `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
         VALUES (?, 'es', '[]', 'La solución es clara', 'h1', ?, ?)`,
      )
      .run(tu.lastInsertRowid, now, now);

    // Diacritic-insensitive, per tokenize = 'unicode61 remove_diacritics 2'.
    expect(
      db.prepare("SELECT rowid FROM tuv_fts WHERE tuv_fts MATCH 'solucion'").all(),
    ).toHaveLength(1);

    db.prepare('UPDATE tuv SET plain = ? WHERE id = ?').run(
      'Algo completamente distinto',
      tuv.lastInsertRowid,
    );
    expect(
      db.prepare("SELECT rowid FROM tuv_fts WHERE tuv_fts MATCH 'solucion'").all(),
    ).toHaveLength(0);
    expect(
      db.prepare("SELECT rowid FROM tuv_fts WHERE tuv_fts MATCH 'distinto'").all(),
    ).toHaveLength(1);

    db.prepare('DELETE FROM tuv WHERE id = ?').run(tuv.lastInsertRowid);
    expect(
      db.prepare("SELECT rowid FROM tuv_fts WHERE tuv_fts MATCH 'distinto'").all(),
    ).toHaveLength(0);
    db.close();
  });
});

describe('crash safety', () => {
  it('integrity_check passes, and an uncommitted write is absent, after a forced kill mid-write', async () => {
    const path = dbPath();
    createTm(path, { name: 'crash test', generator: 'test' }).close();

    // Import better-sqlite3 by resolved absolute path, not a bare
    // specifier, so this script runs correctly regardless of where it
    // sits relative to any node_modules tree.
    const require = createRequire(import.meta.url);
    const driverUrl = pathToFileURL(require.resolve('better-sqlite3')).href;
    const marker = join(dir, 'reached');
    const script = join(dir, 'crash-writer.mjs');
    writeFileSync(
      script,
      `
        import Database from ${JSON.stringify(driverUrl)};
        import { writeFileSync } from 'node:fs';
        const db = new Database(${JSON.stringify(path)});
        db.pragma('journal_mode = WAL');
        db.exec('BEGIN');
        const insertTu = db.prepare(
          "INSERT INTO tu (uuid, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))",
        );
        const insertTuv = db.prepare(
          "INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at) " +
          "VALUES (?, 'en', '[]', ?, ?, datetime('now'), datetime('now'))",
        );
        for (let i = 0; i < 200; i++) {
          const info = insertTu.run('crash-' + i);
          insertTuv.run(info.lastInsertRowid, 'text ' + i, 'hash' + i);
        }
        // Never committed: prove we got this far, then hang for the
        // parent to hard-kill us mid-transaction.
        writeFileSync(${JSON.stringify(marker)}, 'reached');
        setInterval(() => {}, 1000);
        `,
    );

    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = setInterval(() => {
        if (existsSync(marker)) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error('crash-writer never reached the marker'));
        }
      }, 20);
    });

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    const db = new Database(path);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    // The transaction never committed, so none of the 200 rows landed —
    // only the tu-free identity row created before the crash exists.
    expect((db.prepare('SELECT COUNT(*) AS n FROM tu').get() as { n: number }).n).toBe(0);
    db.close();
  }, 15_000);
});
