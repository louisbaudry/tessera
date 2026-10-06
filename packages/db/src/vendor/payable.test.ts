/**
 * A vendor's payable (backlog #49; vendor-spec.md decisions 9–10): a
 * project's words by tier, priced with the rate card in force on a date.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, fuzzyOrigin, rulesFor, segmentWords } from '@cat-tool/core';
import { tierForOrigin } from '@cat-tool/vendor-core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { insertFile } from '../project/files.js';
import { openProjectDb } from '../project/index.js';
import { listSegments } from '../project/segments.js';
import {
  addVendor,
  analyseTierWords,
  createVendorFile,
  priceTierWords,
  setVendorRate,
  VendorError,
} from './index.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx/rich-mixed-content.docx',
);
const T0 = new Date('2026-03-01T10:00:00Z');
const PAIR = { src: 'en', tgt: 'de' };

let dir: string;
let ctv: Database;
let project: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-payable-'));
  ctv = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  project = openProjectDb(join(dir, 'project.catdb'));
});
afterEach(() => {
  ctv.close();
  project.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const addFile = () =>
  insertFile(
    project,
    'a.docx',
    assembleFile(new Uint8Array(readFileSync(FIXTURE)), rulesFor('en')),
    { actor: TEST_ACTOR },
  );

const rate = (tier: 'no_match' | 'exact' | 'ice', rateMicros: number, currency = 'EUR') =>
  setVendorRate(ctv, {
    vendorId: 1,
    pair: PAIR,
    tier,
    rateMicros,
    currency,
    effectiveFrom: '2026-03-01',
    actor: TEST_ACTOR,
    now: T0,
  });

describe('analyseTierWords', () => {
  it('puts an untouched file wholly in no_match, and counts what segmentWords counts', () => {
    const file = addFile();
    const expected = listSegments(project, file.id).reduce(
      (n, s) => n + segmentWords(s),
      0,
    );
    expect(expected).toBeGreaterThan(0);
    expect(analyseTierWords(project, file.id)).toEqual({ no_match: expected });
    expect(analyseTierWords(project)).toEqual({ no_match: expected });
  });

  it('reads the origin a segment was pre-translated with', () => {
    const file = addFile();
    const [first] = listSegments(project, file.id).filter((s) => segmentWords(s) > 0);
    project
      .prepare('UPDATE segment SET origin = ? WHERE id = ?')
      .run('tm_exact', first!.id);
    const words = analyseTierWords(project, file.id);
    expect(words.exact).toBe(segmentWords(first!));
    expect(words.no_match).toBeGreaterThan(0);
  });
});

describe('priceTierWords', () => {
  beforeEach(() => {
    addVendor(ctv, { accountId: 7, displayName: 'Ana Vendor', actor: TEST_ACTOR });
  });

  it('prices each tier at its rate in force on the date', () => {
    rate('no_match', 80_000);
    rate('exact', 8_000);
    const p = priceTierWords(ctv, {
      vendorId: 1,
      pair: PAIR,
      words: { no_match: 100, exact: 50 },
      at: '2026-03-02',
    });
    expect(p).toMatchObject({ totalMicros: 100 * 80_000 + 50 * 8_000, currency: 'EUR' });
    expect(p.unpriced).toEqual([]);
  });

  it('is not moved by a rate written afterwards for a later date', () => {
    rate('no_match', 80_000);
    const before = priceTierWords(ctv, {
      vendorId: 1,
      pair: PAIR,
      words: { no_match: 10 },
      at: '2026-03-02',
    });
    setVendorRate(ctv, {
      vendorId: 1,
      pair: PAIR,
      tier: 'no_match',
      rateMicros: 90_000,
      currency: 'EUR',
      effectiveFrom: '2026-04-01',
      actor: TEST_ACTOR,
      now: T0,
    });
    expect(
      priceTierWords(ctv, {
        vendorId: 1,
        pair: PAIR,
        words: { no_match: 10 },
        at: '2026-03-02',
      }).totalMicros,
    ).toBe(before.totalMicros);
  });

  it('names a tier with words and no rate, instead of pricing it at zero', () => {
    rate('no_match', 80_000);
    const p = priceTierWords(ctv, {
      vendorId: 1,
      pair: PAIR,
      words: { no_match: 10, ice: 4 },
      at: '2026-03-02',
    });
    expect(p.unpriced).toEqual(['ice']);
    expect(p.totalMicros).toBe(800_000);
  });

  it('has no currency, and no total, for a card with nothing in force yet', () => {
    rate('no_match', 80_000);
    const p = priceTierWords(ctv, {
      vendorId: 1,
      pair: PAIR,
      words: { no_match: 10 },
      at: '2026-02-01',
    });
    expect(p).toMatchObject({ totalMicros: 0, currency: null, unpriced: ['no_match'] });
  });

  it('refuses a card in two currencies, and a vendor it does not have', () => {
    rate('no_match', 80_000, 'EUR');
    rate('exact', 8_000, 'USD');
    expect(() =>
      priceTierWords(ctv, {
        vendorId: 1,
        pair: PAIR,
        words: { no_match: 1, exact: 1 },
        at: '2026-03-02',
      }),
    ).toThrow(/more than one currency/);
    expect(() =>
      priceTierWords(ctv, { vendorId: 99, pair: PAIR, words: {}, at: '2026-03-02' }),
    ).toThrow(VendorError);
  });

  it('refuses a source language with no word count rather than invent a unit', () => {
    expect(() =>
      priceTierWords(ctv, {
        vendorId: 1,
        pair: { src: 'ja', tgt: 'en' },
        words: { no_match: 1 },
        at: '2026-03-02',
      }),
    ).toThrow(/no word count/);
  });
});

describe('the origin a fuzzy match is written with', () => {
  // `core` writes `tm_fuzzy_<score>` and `vendor-core` reads it; the two
  // share no import, so this is the one place that holds them to each other
  // (v1-spec.md §6.1a's table of bands).
  it('lands in the tier of its band', () => {
    const tier = (score: number) => tierForOrigin(fuzzyOrigin(score));
    expect([49, 50, 74, 75, 84, 85, 94, 95, 99].map(tier)).toEqual([
      'no_match',
      'fuzzy_50_74',
      'fuzzy_50_74',
      'fuzzy_75_84',
      'fuzzy_75_84',
      'fuzzy_85_94',
      'fuzzy_85_94',
      'fuzzy_95_99',
      'fuzzy_95_99',
    ]);
  });
});
