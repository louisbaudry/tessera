/**
 * A client's own rate for a language pair (issue #331, portal-v0-spec.md §3a): stored per client,
 * in place of the default for that client only, and removable back to the default.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createClient,
  listClientRates,
  listRates,
  listRatesForClient,
  openPortalDb,
  removeClientRate,
  setClientRate,
  setRate,
} from './index.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-client-rates-'));
  db = openPortalDb(join(dir, 'portal.sqlite'));
  setRate(db, { srcLang: 'en', tgtLang: 'de', ratePerWord: 0.1, minimumPrice: 20 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('client rates', () => {
  it('price one client at its own rate and every other at the default', () => {
    const a = createClient(db, 'Client A', 'a@client.example', 'tok-a');
    const b = createClient(db, 'Client B', 'b@client.example', 'tok-b');
    setClientRate(db, a.id, {
      srcLang: 'en',
      tgtLang: 'de',
      ratePerWord: 0.08,
      minimumPrice: 15,
    });
    expect(listRatesForClient(db, a.id)).toEqual([
      {
        srcLang: 'en',
        tgtLang: 'de',
        ratePerWord: 0.08,
        minimumPrice: 15,
        minWordsPerFile: 0,
      },
    ]);
    expect(listRatesForClient(db, b.id)).toEqual(listRates(db));
    // the default itself is untouched
    expect(listRates(db)[0]!.ratePerWord).toBe(0.1);
  });

  it('update in place, and fall back to the default once removed', () => {
    const a = createClient(db, 'Client A', 'a@client.example', 'tok-a');
    const own = { srcLang: 'en', tgtLang: 'de', ratePerWord: 0.08, minimumPrice: 15 };
    setClientRate(db, a.id, own);
    setClientRate(db, a.id, { ...own, ratePerWord: 0.07 });
    expect(listClientRates(db, a.id)).toHaveLength(1);
    expect(listRatesForClient(db, a.id)[0]!.ratePerWord).toBe(0.07);
    expect(removeClientRate(db, a.id, 'en', 'de')).toBe(true);
    expect(removeClientRate(db, a.id, 'en', 'de')).toBe(false);
    expect(listRatesForClient(db, a.id)).toEqual(listRates(db));
  });

  it('offer a pair with no default to its client alone', () => {
    const a = createClient(db, 'Client A', 'a@client.example', 'tok-a');
    const b = createClient(db, 'Client B', 'b@client.example', 'tok-b');
    setClientRate(db, a.id, {
      srcLang: 'en',
      tgtLang: 'ja',
      ratePerWord: 0.2,
      minimumPrice: 30,
    });
    expect(listRatesForClient(db, a.id).map((r) => r.tgtLang)).toEqual(['de', 'ja']);
    expect(listRatesForClient(db, b.id).map((r) => r.tgtLang)).toEqual(['de']);
  });

  it('are refused for a client that does not exist, or with prices the schema forbids', () => {
    expect(() =>
      setClientRate(db, 999, {
        srcLang: 'en',
        tgtLang: 'de',
        ratePerWord: 0.1,
        minimumPrice: 0,
      }),
    ).toThrow();
    const a = createClient(db, 'Client A', 'a@client.example', 'tok-a');
    expect(() =>
      setClientRate(db, a.id, {
        srcLang: 'en',
        tgtLang: 'de',
        ratePerWord: 0,
        minimumPrice: 0,
      }),
    ).toThrow();
    expect(() =>
      setClientRate(db, a.id, {
        srcLang: 'en',
        tgtLang: 'de',
        ratePerWord: 0.1,
        minimumPrice: 0,
        minWordsPerFile: -1,
      }),
    ).toThrow(RangeError);
  });
});
