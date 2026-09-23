/**
 * Native `.sdltm` → `.ctm` import (backlog #18b Phase 2b).
 *
 * The parser's own tests live in `sdltm.test.ts`; these are about what
 * actually lands in the `.ctm` file — the bilingual-to-multilingual step,
 * the context decision, and the several ways a real memory is untidy.
 *
 * Same caveat as the parser's: the input is synthetic (`sdltm.fixture.ts`).
 * These prove the writing is right *given* the schema this project believes
 * Trados uses; they cannot prove the belief. See the file header there.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashOf, type TmToken } from '@cat-tool/core';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TmError } from './errors.js';
import { importSdltm, importSdltmFrom } from './import-sdltm.js';
import { createTm } from './index.js';
import { retrievePair } from './retrieve.js';
import {
  createSyntheticSdltm,
  segmentXml,
  textSegment,
  type SyntheticSdltmOptions,
} from './sdltm.fixture.js';

let dir: string | undefined;
const opened: Database.Database[] = [];

const dbPath = (name = 'memory.ctm'): string => {
  dir ??= mkdtempSync(join(tmpdir(), 'cat-import-sdltm-'));
  return join(dir, name);
};

/** Registers a handle so `afterEach` closes it. */
function track(db: Database.Database): Database.Database {
  opened.push(db);
  return db;
}

/** A fresh `.ctm`, tracked. */
function newTm(): Database.Database {
  return track(createTm(dbPath(), { name: 'target', generator: 'test' }));
}

// Every handle is closed before the directory goes, and the directory is
// forgotten whether or not the removal worked. Windows cannot unlink a file
// that is still open — a leaked handle there made `rmSync` throw, which
// skipped the reset below, which handed the next test an already-initialised
// `.ctm` at the same path. Three CI failures, one missing `close()`.
afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test itself; nothing to do.
    }
  }
  try {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    dir = undefined;
  }
});

/** Imports a synthetic memory into a fresh `.ctm` and hands back both. */
function importInto(options: SyntheticSdltmOptions): {
  db: Database.Database;
  result: ReturnType<typeof importSdltmFrom>;
} {
  const db = newTm();
  const sdltm = createSyntheticSdltm(options);
  try {
    return { db, result: importSdltmFrom(db, sdltm) };
  } finally {
    sdltm.close();
  }
}

const HELLO = {
  source: textSegment('Hello world'),
  target: textSegment('Hola mundo', 'es-MX'),
};

describe('importSdltm — the bilingual-to-multilingual step', () => {
  it('writes one language-neutral unit with a variant per language', () => {
    const { db, result } = importInto({ units: [HELLO] });
    expect(result.tuCount).toBe(1);
    expect(result.tuvCount).toBe(2);

    const rows = db
      .prepare(
        'SELECT lang, plain, hash, quality, prev_hash, next_hash FROM tuv ORDER BY lang',
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r['lang'])).toEqual(['en-US', 'es-MX']);
    expect(rows.map((r) => r['plain'])).toEqual(['Hello world', 'Hola mundo']);
    expect(rows[0]!['hash']).toBe(hashOf('Hello world'));
    // §6: an imported unit is "confirmed", never "reviewed".
    expect(rows.map((r) => r['quality'])).toEqual([2, 2]);
  });

  it('retrieves in both directions, because the schema never encoded one', () => {
    const { db } = importInto({ units: [HELLO] });
    const forward = retrievePair(db, {
      srcLang: 'en',
      srcHash: hashOf('Hello world'),
      tgtLang: 'es',
    });
    const backward = retrievePair(db, {
      srcLang: 'es-MX',
      srcHash: hashOf('Hola mundo'),
      tgtLang: 'en-GB',
    });
    expect(forward).toHaveLength(1);
    expect(backward).toHaveLength(1);
    expect(forward[0]!.tokens).toEqual([{ t: 'text', v: 'Hola mundo' }]);
    expect(backward[0]!.tokens).toEqual([{ t: 'text', v: 'Hello world' }]);
  });

  it('refreshes tm.langs from what tuv actually holds', () => {
    const { db } = importInto({ units: [HELLO] });
    const { langs } = db.prepare('SELECT langs FROM tm WHERE id = 1').get() as {
      langs: string;
    };
    expect(JSON.parse(langs)).toEqual(['en-US', 'es-MX']);
  });

  it('refuses a memory whose two sides are the same language', () => {
    const sdltm = createSyntheticSdltm({
      sourceLang: 'en-US',
      targetLang: 'en-GB',
      units: [HELLO],
    });
    const db = newTm();
    try {
      expect(() => importSdltmFrom(db, sdltm)).toThrow(TmError);
      expect(db.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 0 });
    } finally {
      sdltm.close();
    }
  });

  it('is not a merge: importing the same memory twice writes it twice', () => {
    const { db } = importInto({ units: [HELLO] });
    const again = createSyntheticSdltm({ units: [HELLO] });
    try {
      importSdltmFrom(db, again);
    } finally {
      again.close();
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM tu').get()).toEqual({ n: 2 });
  });
});

describe('importSdltm — tags', () => {
  const tagged = (canHide: boolean): SyntheticSdltmOptions => ({
    units: [
      {
        source: segmentXml([
          { tag: 'Start', anchor: 1, canHide },
          'Page ',
          { tag: 'End', anchor: 1, canHide },
          '1',
        ]),
        target: segmentXml(
          [
            { tag: 'Start', anchor: 1, canHide },
            'Página ',
            { tag: 'End', anchor: 1, canHide },
            '1',
          ],
          'es-MX',
        ),
      },
    ],
  });

  it('keeps a visible pair around the text it actually wraps', () => {
    // Phase 2a emitted every tag before every text, so this segment came
    // out as open/close/text — the tags no longer wrapped anything.
    const { db, result } = importInto(tagged(false));
    const tokens = JSON.parse(
      (
        db.prepare("SELECT tokens FROM tuv WHERE lang = 'en-US'").get() as {
          tokens: string;
        }
      ).tokens,
    ) as TmToken[];
    expect(tokens).toEqual([
      { t: 'open', id: 1 },
      { t: 'text', v: 'Page ' },
      { t: 'close', id: 1 },
      { t: 'text', v: '1' },
    ]);
    expect(result.warnings.join('\n')).toMatch(/carry tags with no kind hint/);
  });

  it('leaves a CanHide pair out of the token stream, keeping its text', () => {
    const { db, result } = importInto(tagged(true));
    const tokens = JSON.parse(
      (
        db.prepare("SELECT tokens FROM tuv WHERE lang = 'en-US'").get() as {
          tokens: string;
        }
      ).tokens,
    ) as TmToken[];
    expect(tokens).toEqual([
      { t: 'text', v: 'Page ' },
      { t: 'text', v: '1' },
    ]);
    expect(result.warnings.join('\n')).toMatch(/marked CanHide were left out/);
  });

  it('drops a pair whose halves disagree about CanHide, never half of it', () => {
    // Keeping the visible half alone would leave an unclosed open tag in
    // the memory — a match that can never be placed.
    const { db } = importInto({
      units: [
        {
          source: segmentXml([
            { tag: 'Start', anchor: 1, canHide: false },
            'x',
            { tag: 'End', anchor: 1, canHide: true },
          ]),
          target: textSegment('y', 'es-MX'),
        },
      ],
    });
    const tokens = JSON.parse(
      (
        db.prepare("SELECT tokens FROM tuv WHERE lang = 'en-US'").get() as {
          tokens: string;
        }
      ).tokens,
    ) as TmToken[];
    expect(tokens).toEqual([{ t: 'text', v: 'x' }]);
  });

  it('falls back to text only when the tag structure is invalid, and says so', () => {
    const { db, result } = importInto({
      units: [
        {
          // Two pairs that cross: <1><2></1></2>.
          source: segmentXml([
            { tag: 'Start', anchor: 1 },
            'a',
            { tag: 'Start', anchor: 2 },
            'b',
            { tag: 'End', anchor: 1 },
            'c',
            { tag: 'End', anchor: 2 },
          ]),
          target: textSegment('abc', 'es-MX'),
        },
      ],
    });
    const row = db
      .prepare("SELECT tokens, plain, hash FROM tuv WHERE lang = 'en-US'")
      .get() as {
      tokens: string;
      plain: string;
      hash: string;
    };
    expect(JSON.parse(row.tokens)).toEqual([
      { t: 'text', v: 'a' },
      { t: 'text', v: 'b' },
      { t: 'text', v: 'c' },
    ]);
    // §4 drops tags before hashing, so dropping them costs matching nothing.
    expect(row.hash).toBe(hashOf('abc'));
    expect(result.warnings.join('\n')).toMatch(/invalid tag structure \(interleaved\)/);
  });
});

describe('importSdltm — context is provenance, not §5 context', () => {
  const withContexts: SyntheticSdltmOptions = {
    units: [
      {
        ...HELLO,
        contexts: [
          { source: '1741029398', target: '885211174' },
          { source: '992113044', target: null },
        ],
      },
    ],
  };

  it('never writes a Trados hash into prev_hash/next_hash', () => {
    const { db, result } = importInto(withContexts);
    const rows = db.prepare('SELECT prev_hash, next_hash FROM tuv').all();
    expect(rows).toEqual([
      { prev_hash: null, next_hash: null },
      { prev_hash: null, next_hash: null },
    ]);
    expect(result.contextOccurrences).toBe(2);
  });

  it('carries every occurrence into tu_attr, intact', () => {
    const { db } = importInto(withContexts);
    const row = db
      .prepare("SELECT value FROM tu_attr WHERE key = 'x-sdltm-contexts'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual([
      { s: '1741029398', t: '885211174' },
      { s: '992113044', t: null },
    ]);
  });

  it('says plainly that no .sdltm-sourced unit is ICE-capable', () => {
    const { result } = importInto(withContexts);
    const line = result.warnings.find((w) => w.includes('x-sdltm-contexts'));
    expect(line).toMatch(/not as prev_hash\/next_hash/);
    expect(line).toMatch(/left context only/);
    expect(line).toMatch(/No \.sdltm-sourced unit is ICE-capable/);
  });

  it('still says so when the memory has no context rows at all', () => {
    const { result } = importInto({ units: [HELLO] });
    expect(result.warnings.join('\n')).toMatch(/no context rows in this memory/);
  });

  it('records the source unit id, so a later pass can line these up again', () => {
    const { db } = importInto({ units: [HELLO] });
    const row = db
      .prepare("SELECT value FROM tu_attr WHERE key = 'x-sdltm-id'")
      .get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThan(0);
  });
});

describe('importSdltm — untidy real-memory shapes', () => {
  it('skips a unit with no source text', () => {
    const { db, result } = importInto({
      units: [HELLO, { source: textSegment(''), target: textSegment('Hola', 'es-MX') }],
    });
    expect(result.tuCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv').get()).toEqual({ n: 2 });
    expect(result.warnings.join('\n')).toMatch(/1 unit\(s\) have no source text/);
  });

  it('imports a unit with an empty target, flagged', () => {
    const { result } = importInto({
      units: [{ source: textSegment('Hello'), target: textSegment('', 'es-MX') }],
    });
    expect(result.tuCount).toBe(1);
    expect(result.warnings.join('\n')).toMatch(/1 unit\(s\) have an empty target/);
  });

  it('keeps the first value when a unit repeats a Trados attribute', () => {
    const { db, result } = importInto({
      units: [
        {
          ...HELLO,
          attributes: [
            { name: 'SourceFile', value: 'first.docx' },
            { name: 'SourceFile', value: 'second.docx' },
          ],
        },
      ],
    });
    const row = db
      .prepare("SELECT value FROM tu_attr WHERE key = 'SourceFile'")
      .get() as {
      value: string;
    };
    expect(row.value).toBe('first.docx');
    expect(result.warnings.join('\n')).toMatch(
      /repeat the Trados attribute "SourceFile"/,
    );
  });

  it("flags a segment whose CultureName disagrees with the memory's pair", () => {
    const { result } = importInto({
      units: [{ source: textSegment('Hello'), target: textSegment('Bonjour', 'fr-FR') }],
    });
    expect(result.warnings.join('\n')).toMatch(
      /disagrees with the memory's own language pair/,
    );
  });

  it("flags a disagreement with the file's own tucount", () => {
    const { result } = importInto({ declaredUnitCount: 7, units: [HELLO] });
    expect(result.warnings.join('\n')).toMatch(
      /tucount says 7 unit\(s\) but 1 were read/,
    );
  });

  it('carries usage stats and timestamps onto both variants', () => {
    const { db } = importInto({
      units: [
        {
          ...HELLO,
          usageCounter: 1041,
          lastUsedDate: '2026-03-04 09:15:22',
          creationDate: '2019-06-01 08:00:00',
          changeDate: '2024-11-12 17:30:00',
          creationUser: 'DOMAIN\\alice',
          changeUser: 'DOMAIN\\bob',
        },
      ],
    });
    const rows = db
      .prepare(
        'SELECT usage_count, last_used_at, created_at, updated_at, updated_by FROM tuv',
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row['usage_count']).toBe(1041);
      expect(row['last_used_at']).toBe('2026-03-04T09:15:22.000Z');
      expect(row['created_at']).toBe('2019-06-01T08:00:00.000Z');
      expect(row['updated_at']).toBe('2024-11-12T17:30:00.000Z');
      expect(row['updated_by']).toBe('DOMAIN\\bob');
    }
    const tu = db.prepare('SELECT created_by FROM tu').get();
    expect(tu).toEqual({ created_by: 'DOMAIN\\alice' });
  });

  it('reports a repeated problem once per cause across a whole memory', () => {
    // The 4,615-line import report (backlog #18) is the failure mode this
    // guards: a hand-built fixture never shows it, a real memory always does.
    const { result } = importInto({
      units: Array.from({ length: 500 }, (_, i) => ({
        source: textSegment(`Segment number ${i}`),
        target: textSegment('', 'es-MX'),
        attributes: [
          { name: 'SourceFile', value: 'a.docx' },
          { name: 'SourceFile', value: 'b.docx' },
        ],
      })),
    });
    expect(result.tuCount).toBe(500);
    expect(result.warnings.filter((w) => w.includes('empty target'))).toEqual([
      '500 unit(s) have an empty target — imported, but they can only ever match as blanks',
    ]);
    expect(result.warnings.filter((w) => w.includes('SourceFile'))).toHaveLength(1);
    expect(result.warnings.length).toBeLessThan(10);
  });
});

describe('importSdltm — opening the file', () => {
  it('imports from a path, leaving the Trados file untouched', () => {
    const sdltmPath = dbPath('client.sdltm');
    const sdltm = track(createSyntheticSdltm({ path: sdltmPath, units: [HELLO] }));
    sdltm.close();

    const db = newTm();
    const result = importSdltm(db, sdltmPath);
    expect(result.tuCount).toBe(1);
    expect(result.tuvCount).toBe(2);

    // Opened read-only: the translator's original must survive an import.
    const reopened = track(new Database(sdltmPath, { readonly: true }));
    try {
      expect(
        reopened.prepare('SELECT COUNT(*) AS n FROM translation_units').get(),
      ).toEqual({ n: 1 });
    } finally {
      reopened.close();
    }
  });

  it('refuses a path that is not there', () => {
    const db = newTm();
    expect(() => importSdltm(db, join(dbPath(), 'nope.sdltm'))).toThrow(TmError);
  });
});
