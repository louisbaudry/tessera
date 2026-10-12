/**
 * A minimum per file (portal-v0-spec.md §4b; idea #222): the rate setting,
 * the admin-confirmed count per source file, and the pricing write that
 * stores them together with the price they produced.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OrderPricingError } from '@cat-tool/portal-core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import {
  createClient,
  createOrder,
  insertSourceFile,
  listRates,
  listSourceFiles,
  openPortalDb,
  setRate,
  setStatus,
  setWordCountAndPrice,
} from './index.js';
import { PORTAL_APPLICATION_ID, PORTAL_MIGRATIONS } from './schema.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-minimum-'));
  db = openPortalDb(join(dir, 'portal.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

let clients = 0;

function orderWithFiles(counts: ReadonlyArray<number | null>) {
  clients += 1;
  const client = createClient(
    db,
    `Client ${clients}`,
    `client-${clients}@client.example`,
    `tok-${clients}`,
  );
  const order = createOrder(
    db,
    { clientId: client.id, srcLang: 'en', tgtLangs: ['de'] },
    { actor: TEST_ACTOR },
  );
  const files = counts.map((wordCount, i) =>
    insertSourceFile(db, {
      orderId: order.id,
      filename: `file-${i}.docx`,
      contentType: 'application/octet-stream',
      byteSize: 3,
      storagePath: `orders/${order.id}/source/file-${i}.docx`,
      wordCount,
    }),
  );
  return { order, files };
}

const counts = (...pairs: Array<[number, number]>) => new Map(pairs);

describe('rate.min_words_per_file (schema v8)', () => {
  it('is off for a rate written before the setting existed', () => {
    db.close();
    const path = join(dir, 'v7.sqlite');
    const old = openAndMigrate(path, {
      applicationId: PORTAL_APPLICATION_ID,
      migrations: PORTAL_MIGRATIONS.slice(0, 7),
    });
    old.exec(
      "INSERT INTO rate (src_lang, tgt_lang, rate_per_word, minimum_price) VALUES ('en', 'de', 0.1, 40)",
    );
    old.close();

    db = openPortalDb(path);
    expect(listRates(db)).toEqual([
      {
        srcLang: 'en',
        tgtLang: 'de',
        ratePerWord: 0.1,
        minimumPrice: 40,
        minWordsPerFile: 0,
      },
    ]);
  });

  it('round-trips a per-file minimum, and a rate that omits it has none', () => {
    setRate(db, {
      srcLang: 'en',
      tgtLang: 'de',
      ratePerWord: 0.1,
      minimumPrice: 0,
      minWordsPerFile: 250,
    });
    setRate(db, { srcLang: 'en', tgtLang: 'fr', ratePerWord: 0.12, minimumPrice: 50 });
    expect(listRates(db).map((r) => [r.tgtLang, r.minWordsPerFile])).toEqual([
      ['de', 250],
      ['fr', 0],
    ]);
  });

  it('changes the setting on an existing rate and leaves the rest', () => {
    setRate(db, { srcLang: 'en', tgtLang: 'de', ratePerWord: 0.1, minimumPrice: 40 });
    setRate(db, {
      srcLang: 'en',
      tgtLang: 'de',
      ratePerWord: 0.1,
      minimumPrice: 40,
      minWordsPerFile: 100,
    });
    expect(listRates(db)).toHaveLength(1);
    expect(listRates(db)[0]).toMatchObject({ minimumPrice: 40, minWordsPerFile: 100 });
  });
});

describe('setWordCountAndPrice with a count per file', () => {
  it('stores each confirmed count beside the price, and the total as the order count', () => {
    const { order, files } = orderWithFiles([90, 400]);
    const [a, b] = files;
    const priced = setWordCountAndPrice(db, order.id, 490, 65, {
      actor: TEST_ACTOR,
      fileWordCounts: counts([a!.id, 90], [b!.id, 400]),
    });
    // The order keeps the actual words; the billed words only show in the price.
    expect(priced).toMatchObject({ wordCount: 490, price: 65 });
    expect(listSourceFiles(db, order.id).map((f) => f.confirmedWordCount)).toEqual([
      90, 400,
    ]);
  });

  it('leaves the advisory count alone', () => {
    const { order, files } = orderWithFiles([90]);
    setWordCountAndPrice(db, order.id, 95, 25, {
      actor: TEST_ACTOR,
      fileWordCounts: counts([files[0]!.id, 95]),
    });
    expect(listSourceFiles(db, order.id)[0]).toMatchObject({
      wordCount: 90,
      confirmedWordCount: 95,
    });
  });

  it('has no confirmed count for a file nobody confirmed', () => {
    const { order } = orderWithFiles([90]);
    setWordCountAndPrice(db, order.id, 90, 9, { actor: TEST_ACTOR });
    expect(listSourceFiles(db, order.id)[0]?.confirmedWordCount).toBeNull();
  });

  it('refuses a total that is not the sum of the files, and writes nothing', () => {
    const { order, files } = orderWithFiles([90, 400]);
    expect(() =>
      setWordCountAndPrice(db, order.id, 500, 65, {
        actor: TEST_ACTOR,
        fileWordCounts: counts([files[0]!.id, 90], [files[1]!.id, 400]),
      }),
    ).toThrow(RangeError);
    expect(listSourceFiles(db, order.id).map((f) => f.confirmedWordCount)).toEqual([
      null,
      null,
    ]);
    expect(listEvents(db, { subjectType: 'translation_order' })).toEqual([]);
  });

  it('refuses counts that miss a file or name one the order does not have', () => {
    const { order, files } = orderWithFiles([90, 400]);
    const other = orderWithFiles([10]);
    const price = { actor: TEST_ACTOR };
    expect(() =>
      setWordCountAndPrice(db, order.id, 90, 9, {
        ...price,
        fileWordCounts: counts([files[0]!.id, 90]),
      }),
    ).toThrow(RangeError);
    expect(() =>
      setWordCountAndPrice(db, order.id, 100, 10, {
        ...price,
        // Another order's file id must never be written through this order.
        fileWordCounts: counts([files[0]!.id, 90], [other.files[0]!.id, 10]),
      }),
    ).toThrow(RangeError);
    expect(listSourceFiles(db, other.order.id)[0]?.confirmedWordCount).toBeNull();
  });

  it('refuses a negative or fractional count', () => {
    const { order, files } = orderWithFiles([90]);
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() =>
        setWordCountAndPrice(db, order.id, bad, 1, {
          actor: TEST_ACTOR,
          fileWordCounts: counts([files[0]!.id, bad]),
        }),
      ).toThrow(RangeError);
    }
  });

  it('records the per-file counts in order.priced, and nothing for a repeat', () => {
    const { order, files } = orderWithFiles([90, 400]);
    const fileWordCounts = counts([files[0]!.id, 90], [files[1]!.id, 400]);
    const price = (n: number) =>
      setWordCountAndPrice(db, order.id, 490, n, { actor: TEST_ACTOR, fileWordCounts });
    price(65);
    price(65);
    const events = listEvents(db, {
      subjectType: 'translation_order',
      subjectId: String(order.id),
    });
    expect(events.map((e) => [e.action, e.detail])).toEqual([
      [
        'order.priced',
        JSON.stringify({
          word_count: 490,
          price: 65,
          files: { [files[0]!.id]: 90, [files[1]!.id]: 400 },
        }),
      ],
    ]);
    expect(verifyAudit(db)).toEqual({ events: 1, brokenAt: null });
  });

  it('counts a changed split of the same total and price as a change', () => {
    const { order, files } = orderWithFiles([90, 400]);
    const [a, b] = [files[0]!.id, files[1]!.id];
    setWordCountAndPrice(db, order.id, 490, 65, {
      actor: TEST_ACTOR,
      fileWordCounts: counts([a, 90], [b, 400]),
    });
    // Same total, same price, different files: the confirmation changed.
    setWordCountAndPrice(db, order.id, 490, 65, {
      actor: TEST_ACTOR,
      fileWordCounts: counts([a, 100], [b, 390]),
    });
    expect(listSourceFiles(db, order.id).map((f) => f.confirmedWordCount)).toEqual([
      100, 390,
    ]);
    expect(
      listEvents(db, { subjectType: 'translation_order', subjectId: String(order.id) }),
    ).toHaveLength(2);
  });

  it('clears the per-file counts when the order is later priced from a total alone', () => {
    // A confirmed count that disagrees with the order's total is a hole in the
    // record: the total is the sum of the counts whenever counts exist.
    const { order, files } = orderWithFiles([90, 400]);
    setWordCountAndPrice(db, order.id, 490, 65, {
      actor: TEST_ACTOR,
      fileWordCounts: counts([files[0]!.id, 90], [files[1]!.id, 400]),
    });
    setWordCountAndPrice(db, order.id, 1000, 100, { actor: TEST_ACTOR });
    expect(listSourceFiles(db, order.id).map((f) => f.confirmedWordCount)).toEqual([
      null,
      null,
    ]);
  });

  it('cannot change the counts of an approved order', () => {
    const { order, files } = orderWithFiles([90]);
    const id = files[0]!.id;
    setWordCountAndPrice(db, order.id, 90, 25, {
      actor: TEST_ACTOR,
      fileWordCounts: counts([id, 90]),
    });
    setStatus(db, order.id, 'approved', { actor: TEST_ACTOR, seenPrice: 25 });
    expect(() =>
      setWordCountAndPrice(db, order.id, 900, 250, {
        actor: TEST_ACTOR,
        fileWordCounts: counts([id, 900]),
      }),
    ).toThrow(OrderPricingError);
    // The price the client approved, and the count that produced it, stand.
    expect(listSourceFiles(db, order.id)[0]?.confirmedWordCount).toBe(90);
  });
});
