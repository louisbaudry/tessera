/**
 * A vendor's payable (backlog #49; vendor-spec.md decisions 9–10): a
 * project's words by tier, priced with the rate card in force on a date.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  fuzzyOrigin,
  plainText,
  rulesFor,
  segmentWords,
} from '@cat-tool/core';
import { tierForOrigin } from '@cat-tool/vendor-core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { insertFile } from '../project/files.js';
import { openProjectDb } from '../project/index.js';
import { createProject } from '../project/project.js';
import { addTmRef, listTmRefs, tmAlias } from '../project/tm-refs.js';
import { createTm } from '../tm/index.js';
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

describe('analyseTierWords: an unplaced segment is read from the memories (v1-spec.md §6.1a, 4)', () => {
  /** A project over a prose file, and its segments of eight plain words or more. */
  function setup() {
    createProject(project, { name: 'p', srcLang: 'en', tgtLang: 'de' });
    const file = insertFile(
      project,
      'prose.docx',
      assembleFile(
        new Uint8Array(readFileSync(join(dirname(FIXTURE), 'prose-short.docx'))),
        rulesFor('en'),
      ),
      { actor: TEST_ACTOR },
    );
    const wordsOnly = (t: string) =>
      t.split(' ').every((w) => /^\p{L}+[.,;:!?]?$/u.test(w));
    const candidates = listSegments(project, file.id).filter((s) => {
      const t = plainText(s.sourceTokens).trim();
      return (
        segmentWords(s) > 0 &&
        s.formatTable.every((f) => !f.visible) &&
        t.split(' ').length >= 8 &&
        wordsOnly(t)
      );
    });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    return { file, a: candidates[0]!, b: candidates[1]! };
  }

  /** A unit with this source text and hash, and a German target. */
  function unit(tm: Database, srcPlain: string, hash: string): void {
    const now = new Date().toISOString();
    const tuId = tm
      .prepare('INSERT INTO tu (uuid, created_at, updated_at) VALUES (?, ?, ?)')
      .run(randomUUID(), now, now).lastInsertRowid as number;
    for (const [lang, text, h] of [
      ['en', srcPlain, hash],
      ['de', 'Ziel', `de:${hash}`],
    ] as const) {
      tm.prepare(
        `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(tuId, lang, JSON.stringify([{ t: 'text', v: text }]), text, h, now, now);
    }
  }

  /** `text` with its last `k` words replaced. */
  const changed = (text: string, k: number): string => {
    const w = text.trim().split(' ');
    return [...w.slice(0, w.length - k), ...Array.from({ length: k }, () => 'zzqx')].join(
      ' ',
    );
  };

  it('prices an exact hit as exact and a 50-74 match as fuzzy_50_74, though neither was placed', () => {
    const { file, a, b } = setup();
    const memory = join(dir, 'm.ctm');
    const tm = createTm(memory, { name: 'm', generator: 'test' });
    unit(tm, 'whatever the text was', a.sourceHash);
    const n = plainText(b.sourceTokens).trim().split(' ').length;
    unit(tm, changed(plainText(b.sourceTokens), Math.ceil(n * 0.3)), 'other-hash');
    tm.close();
    addTmRef(project, { actor: TEST_ACTOR, path: memory, priority: 1 });

    const words = analyseTierWords(project, file.id);
    expect(words.exact).toBe(segmentWords(a));
    expect(words.fuzzy_50_74).toBe(segmentWords(b));
    const total = listSegments(project, file.id).reduce((x, s) => x + segmentWords(s), 0);
    expect(Object.values(words).reduce((x, y) => x + y, 0)).toBe(total);
  });

  it('leaves a segment that has an origin to its origin, whatever the memory says', () => {
    const { file, a } = setup();
    const memory = join(dir, 'm.ctm');
    const tm = createTm(memory, { name: 'm', generator: 'test' });
    unit(tm, 'whatever the text was', a.sourceHash);
    tm.close();
    addTmRef(project, { actor: TEST_ACTOR, path: memory, priority: 1 });
    project
      .prepare('UPDATE segment SET origin = ? WHERE id = ?')
      .run(fuzzyOrigin(80), a.id);

    const words = analyseTierWords(project, file.id);
    expect(words.fuzzy_75_84).toBe(segmentWords(a));
    expect(words.exact).toBeUndefined();
  });

  it('skips a memory whose file is gone, and does not create it', () => {
    const { file } = setup();
    const gone = join(dir, 'gone.ctm');
    addTmRef(project, { actor: TEST_ACTOR, path: gone, priority: 1 });
    const total = listSegments(project, file.id).reduce((x, s) => x + segmentWords(s), 0);
    expect(analyseTierWords(project, file.id)).toEqual({ no_match: total });
    expect(existsSync(gone)).toBe(false);
  });

  it('detaches what it attached, and only that', () => {
    const { file } = setup();
    for (const name of ['one.ctm', 'two.ctm']) {
      createTm(join(dir, name), { name, generator: 'test' }).close();
      addTmRef(project, { actor: TEST_ACTOR, path: join(dir, name), priority: 1 });
    }
    const attachedNames = () =>
      (project.pragma('database_list') as Array<{ name: string }>)
        .map((d) => d.name)
        .filter((n) => n !== 'main' && n !== 'temp');
    expect(attachedNames()).toEqual([]);
    analyseTierWords(project, file.id);
    expect(attachedNames()).toEqual([]);

    // A memory the caller already attached stays attached.
    const [first] = listTmRefs(project);
    project.prepare(`ATTACH DATABASE ? AS ${tmAlias(first!.id)}`).run(first!.path);
    analyseTierWords(project, file.id);
    expect(attachedNames()).toEqual([tmAlias(first!.id)]);
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
