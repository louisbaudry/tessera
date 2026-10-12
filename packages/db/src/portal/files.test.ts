import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { openAndMigrate } from '../migrate.js';
import {
  createClient,
  createOrder,
  getOrder,
  getSourceFile,
  listOrderEvents,
  insertSourceFile,
  listSourceFiles,
  openPortalDb,
  sumSourceWordCounts,
  type SourceFile,
} from './index.js';
import { PORTAL_APPLICATION_ID, PORTAL_MIGRATIONS } from './schema.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-files-'));
  return join(dir, 'portal.sqlite');
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const file = (orderId: number, wordCount: number | null) => ({
  orderId,
  filename: 'a.docx',
  contentType: 'application/octet-stream',
  byteSize: 3,
  storagePath: `orders/${orderId}/source/x`,
  wordCount,
});

describe('source_file.word_count (backlog #62)', () => {
  it('stores an advisory count, or null, and reads it back', () => {
    const db = openPortalDb(dbPath());
    const client = createClient(db, 'Ada', 'ada@client.example', 'tok');
    const order = createOrder(
      db,
      { clientId: client.id, srcLang: 'en', tgtLangs: ['fr'] },
      { actor: TEST_ACTOR },
    );
    const counted = insertSourceFile(db, file(order.id, 120));
    const uncounted = insertSourceFile(db, file(order.id, null));
    expect(counted.wordCount).toBe(120);
    expect(uncounted.wordCount).toBeNull();
    expect(listSourceFiles(db, order.id).map((f) => f.wordCount)).toEqual([120, null]);
    expect(getSourceFile(db, order.id, counted.id)?.wordCount).toBe(120);
    expect(getSourceFile(db, order.id + 1, counted.id)).toBeNull();
    db.close();
  });

  it('never touches the order: the confirmed count and price stay null', () => {
    const db = openPortalDb(dbPath());
    const client = createClient(db, 'Ada', 'ada@client.example', 'tok');
    const order = createOrder(
      db,
      { clientId: client.id, srcLang: 'en', tgtLangs: ['fr'] },
      { actor: TEST_ACTOR },
    );
    insertSourceFile(db, file(order.id, 500));
    const row = db
      .prepare('SELECT word_count, price FROM translation_order WHERE id = ?')
      .get(order.id);
    expect(row).toEqual({ word_count: null, price: null });
    db.close();
  });

  it('a file uploaded before v5 migrates to a null count', () => {
    const path = dbPath();
    const old = openAndMigrate(path, {
      applicationId: PORTAL_APPLICATION_ID,
      migrations: PORTAL_MIGRATIONS.slice(0, 4),
    });
    const client = createClient(old, 'Ada', 'ada@client.example', 'tok');
    old
      .prepare(
        `INSERT INTO translation_order
           (client_id, src_lang, status, created_at, updated_at)
         VALUES (?, 'en', 'submitted', 'now', 'now')`,
      )
      .run(client.id);
    old
      .prepare(
        `INSERT INTO source_file
           (order_id, filename, content_type, byte_size, storage_path, uploaded_at)
         VALUES (1, 'old.docx', 'x', 1, 'p', 'now')`,
      )
      .run();
    old.close();

    const db = openPortalDb(path);
    expect(listSourceFiles(db, 1).map((f) => [f.filename, f.wordCount])).toEqual([
      ['old.docx', null],
    ]);
    db.close();
  });
});

describe('sumSourceWordCounts', () => {
  const at = (wordCount: number | null): SourceFile => ({
    id: 1,
    orderId: 1,
    filename: 'f',
    contentType: 'x',
    byteSize: 1,
    storagePath: 'p',
    uploadedAt: 't',
    wordCount,
    comparedToFileId: null,
    changedWordCount: null,
    confirmedWordCount: null,
  });

  it('adds every file when each has a count', () => {
    expect(sumSourceWordCounts([at(10), at(0), at(5)])).toBe(15);
  });

  it('is null when any file has none: a hole is not a smaller total', () => {
    expect(sumSourceWordCounts([at(10), at(null)])).toBeNull();
  });

  it('is null for no files', () => {
    expect(sumSourceWordCounts([])).toBeNull();
  });
});

describe('sumSourceWordCounts for an update order (backlog #163)', () => {
  const at = (wordCount: number | null, changedWordCount: number | null): SourceFile => ({
    id: 1,
    orderId: 1,
    filename: 'f',
    contentType: 'x',
    byteSize: 1,
    storagePath: 'p',
    uploadedAt: 't',
    wordCount,
    comparedToFileId: null,
    changedWordCount,
    confirmedWordCount: null,
  });
  const only = { changedOnly: true };

  it('adds the changed words, not the whole files', () => {
    expect(sumSourceWordCounts([at(100, 12), at(50, 0)], only)).toBe(12);
    expect(sumSourceWordCounts([at(100, 12), at(50, 0)])).toBe(150);
  });

  it('quotes a file that could not be compared at its whole count', () => {
    expect(sumSourceWordCounts([at(100, 12), at(50, null)], only)).toBe(62);
  });

  it('is still null when a file has no count at all', () => {
    expect(sumSourceWordCounts([at(100, 12), at(null, null)], only)).toBeNull();
  });
});

describe('update orders (backlog #163)', () => {
  it('records the order it updates, in the row and in its creation event', () => {
    const db = openPortalDb(dbPath());
    const client = createClient(db, 'Ada', 'ada@client.example', 'tok');
    const first = createOrder(
      db,
      { clientId: client.id, srcLang: 'en', tgtLangs: ['fr'] },
      { actor: TEST_ACTOR },
    );
    const update = createOrder(
      db,
      { clientId: client.id, srcLang: 'en', tgtLangs: ['fr'], previousOrderId: first.id },
      { actor: TEST_ACTOR },
    );
    expect(first.previousOrderId).toBeNull();
    expect(getOrder(db, update.id)?.previousOrderId).toBe(first.id);
    expect(listOrderEvents(db, update.id).map((e) => e.note)).toEqual([
      `order created as an update of order #${first.id}`,
    ]);
    expect(listOrderEvents(db, first.id).map((e) => e.note)).toEqual(['order created']);
    db.close();
  });

  it('stores what an upload was compared with and how much of it changed', () => {
    const db = openPortalDb(dbPath());
    const client = createClient(db, 'Ada', 'ada@client.example', 'tok');
    const first = createOrder(
      db,
      { clientId: client.id, srcLang: 'en', tgtLangs: ['fr'] },
      { actor: TEST_ACTOR },
    );
    const v1 = insertSourceFile(db, file(first.id, 100));
    const update = createOrder(
      db,
      { clientId: client.id, srcLang: 'en', tgtLangs: ['fr'], previousOrderId: first.id },
      { actor: TEST_ACTOR },
    );
    const v2 = insertSourceFile(db, {
      ...file(update.id, 104),
      comparedToFileId: v1.id,
      changedWordCount: 9,
    });
    expect(v1.comparedToFileId).toBeNull();
    expect(v1.changedWordCount).toBeNull();
    expect(getSourceFile(db, update.id, v2.id)).toMatchObject({
      wordCount: 104,
      comparedToFileId: v1.id,
      changedWordCount: 9,
    });
    db.close();
  });

  it('an order and a file written before v7 migrate to "not an update, not compared"', () => {
    const path = dbPath();
    const old = openAndMigrate(path, {
      applicationId: PORTAL_APPLICATION_ID,
      migrations: PORTAL_MIGRATIONS.slice(0, 6),
    });
    const client = createClient(old, 'Ada', 'ada@client.example', 'tok');
    old
      .prepare(
        `INSERT INTO translation_order
           (client_id, src_lang, status, created_at, updated_at)
         VALUES (?, 'en', 'submitted', 'now', 'now')`,
      )
      .run(client.id);
    old
      .prepare(
        `INSERT INTO source_file
           (order_id, filename, content_type, byte_size, storage_path, uploaded_at)
         VALUES (1, 'old.docx', 'x', 1, 'p', 'now')`,
      )
      .run();
    old.close();

    const db = openPortalDb(path);
    expect(getOrder(db, 1)?.previousOrderId).toBeNull();
    expect(listSourceFiles(db, 1)[0]).toMatchObject({
      comparedToFileId: null,
      changedWordCount: null,
    });
    db.close();
  });
});
