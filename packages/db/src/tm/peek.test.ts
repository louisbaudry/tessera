import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTm, describeTm, openTm, peekTm, TmError } from './index.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  dir = undefined;
});
const path = (name: string): string =>
  join((dir ??= mkdtempSync(join(tmpdir(), 'cat-peek-'))), name);
const digest = (p: string): string =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

/** A closed memory of `n` units, `deleted` of them tombstoned, in two languages. */
function memory(name: string, n = 50, deleted = 0): string {
  const p = path(`${name}.ctm`);
  const db = createTm(p, { name, generator: 'test' });
  const tu = db.prepare(
    `INSERT INTO tu (uuid, created_at, updated_at, deleted) VALUES (?, 't', 't', ?)`,
  );
  const tuv = db.prepare(
    `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
     VALUES (?, ?, '[]', ?, ?, 't', 't')`,
  );
  for (let i = 0; i < n; i++) {
    const id = tu.run(`u${i}`, i < deleted ? 1 : 0).lastInsertRowid as number;
    for (const lang of ['en', 'es']) tuv.run(id, lang, `${lang} ${i}`, `${lang}${i}`);
  }
  db.prepare(`UPDATE tm SET langs = '["en","es"]'`).run();
  db.close();
  return p;
}

/** Overwrites one page of a named index, so `integrity_check` fails and the tables beside it still read. */
function damageIndex(p: string, index: string): void {
  const db = openTm(p);
  const { pageno } = db
    .prepare(`SELECT pageno FROM dbstat WHERE name = ? LIMIT 1`)
    .get(index) as {
    pageno: number;
  };
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  db.close();
  const fd = openSync(p, 'r+');
  writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (pageno - 1) * pageSize);
  closeSync(fd);
}

// Every test builds a memory with openTm/createTm, SQLite-heavy: a fixed 5 s starved
// out twice on the 2-fork Windows runner (#82), so the suite gets the slack the
// other heavy suites have.
describe('peekTm', { timeout: 60_000 }, () => {
  it('describes a memory exactly as opening it does', () => {
    const p = memory('a', 50, 7);
    const opened = openTm(p);
    const expected = describeTm(opened);
    opened.close();
    expect(peekTm(p)).toEqual(expected);
    expect(peekTm(p)).toMatchObject({ name: 'a', units: 43, langs: ['en', 'es'] }); // tombstones are not units
  });

  it('writes nothing, and leaves no sidecar file beside the memory', () => {
    const p = memory('a');
    const before = digest(p);
    peekTm(p);
    peekTm(p);
    expect(digest(p)).toBe(before);
    expect(readdirSync(dir!)).toEqual(['a.ctm']); // a read-only handle would leave -wal and -shm
  });

  it('refuses to write through its handle, so a later edit cannot do it by accident', () => {
    // `query_only` is the guard; prove it holds on a connection opened the same way.
    const p = memory('a');
    const db = openTm(p);
    db.pragma('query_only = ON');
    expect(() => db.prepare('UPDATE tm SET name = ?').run('x')).toThrow(/readonly/i);
    db.close();
  });

  it('answers while another connection holds an open write transaction, seeing only what is committed', () => {
    const p = memory('a', 10);
    const writer = openTm(p);
    writer.exec('BEGIN IMMEDIATE');
    writer
      .prepare(`INSERT INTO tu (uuid, created_at, updated_at) VALUES ('new', 't', 't')`)
      .run();
    expect(peekTm(p).units).toBe(10);
    writer.exec('COMMIT');
    expect(peekTm(p).units).toBe(11);
    writer.close();
  });

  it('describes an older format as it is, unmigrated, and takes no backup', () => {
    const p = memory('old');
    const db = openTm(p);
    db.exec('DROP TABLE tm_import');
    db.pragma('user_version = 1');
    db.close();
    expect(peekTm(p)).toMatchObject({ name: 'old', units: 50 });
    const after = openSync(p, 'r');
    closeSync(after);
    expect(readdirSync(dir!).filter((f) => f.includes('.bak'))).toEqual([]);
    // still format 1: peeking migrated nothing (opening it would)
    const check = openTm(p); // migrates now, on purpose, to see that it had not before
    check.close();
    expect(readdirSync(dir!).filter((f) => f.includes('.bak-v1-')).length).toBe(1);
  });

  describe('the policy it does not change (§10)', () => {
    it('lists a damaged memory normally, and opening it is still refused', () => {
      const p = memory('damaged', 500);
      damageIndex(p, 'tuv_lookup');
      // the listing does not verify the file...
      expect(peekTm(p)).toMatchObject({ name: 'damaged', units: 500 });
      // ...and the open that would use it still refuses it. On damage this
      // bad `integrity_check` itself throws (SQLITE_CORRUPT) rather than
      // returning rows, so the refusal is SQLite's error, not `MigrationError`.
      expect(() => openTm(p)).toThrow(/malformed|integrity_check/);
    });
  });

  describe('what it refuses, by the header alone', () => {
    it('a file that does not exist, without creating it', () => {
      expect(() => peekTm(path('missing.ctm'))).toThrow(TmError);
      expect(readdirSync(dir!)).toEqual([]);
    });

    it('a file that is not a database', () => {
      const p = path('text.ctm');
      writeFileSync(p, 'this is not a database, not even close to one');
      expect(() => peekTm(p)).toThrow(TmError);
    });

    it('a database that is not a .ctm', () => {
      const p = memory('other');
      const db = openTm(p);
      db.pragma('application_id = 12345');
      db.close();
      expect(() => peekTm(p)).toThrow(/not a \.ctm/);
    });

    it('a memory in a newer format than this build reads', () => {
      const p = memory('future');
      const db = openTm(p);
      db.pragma('user_version = 99');
      db.close();
      expect(() => peekTm(p)).toThrow(/newer than/);
    });
  });
});
