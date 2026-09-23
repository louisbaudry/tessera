/**
 * Native `.sdltm` parsing (backlog #18b).
 *
 * Synthetic databases built from `sdltm.fixture.ts` — this project's
 * written-down belief about Trados Studio 8.06's schema (tm-format-spec.md
 * §8a). **That is the limit of what these tests prove.** They cannot show
 * the belief is right; only a real file can, and #18b's remaining work is
 * exactly that. What they *can* do, and what most of the cases below are
 * for, is show that this reader degrades sensibly when the file disagrees
 * with the belief — a missing table, a missing column, a tag type never
 * observed — rather than throwing or, worse, silently losing content.
 */

import {
  parseSdltm,
  parseSdltmSegment,
  sdltmDateToIso,
  SdltmError,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSyntheticSdltm,
  segmentXml,
  textSegment,
  type SyntheticSdltmOptions,
} from './sdltm.fixture.js';

let db: Database.Database | undefined;

function sdltm(options: SyntheticSdltmOptions = {}): Database.Database {
  db = createSyntheticSdltm(options);
  return db;
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('parseSdltm — schema compatibility', () => {
  it('rejects a file without the Trados application_id', () => {
    expect(() => parseSdltm(sdltm({ applicationId: 0 }))).toThrow(SdltmError);
  });

  it('reads the language pair, name and Trados version', () => {
    const parsed = parseSdltm(
      sdltm({
        sourceLang: 'en-US',
        targetLang: 'es-MX',
        name: 'Client A',
        version: '8.06',
      }),
    );
    expect(parsed.sourceLang).toBe('en-US');
    expect(parsed.targetLang).toBe('es-MX');
    expect(parsed.name).toBe('Client A');
    expect(parsed.version).toBe('8.06');
  });

  it("reads the file's own tucount separately from what it actually holds", () => {
    const parsed = parseSdltm(
      sdltm({
        declaredUnitCount: 99,
        units: [{ source: textSegment('Hello'), target: textSegment('Hola', 'es-MX') }],
      }),
    );
    expect(parsed.declaredUnitCount).toBe(99);
    expect(parsed.units).toHaveLength(1);
  });

  it('throws when there is no memory row to read', () => {
    expect(() => parseSdltm(sdltm())).not.toThrow();
    const empty = createSyntheticSdltm();
    empty.prepare('DELETE FROM translation_memories').run();
    try {
      expect(() => parseSdltm(empty)).toThrow(/no memory to read/);
    } finally {
      empty.close();
    }
  });

  it('throws when the memory declares no language pair', () => {
    expect(() => parseSdltm(sdltm({ sourceLang: '', targetLang: '' }))).toThrow(
      /no language pair/,
    );
  });

  it('warns rather than throwing when a side table is missing', () => {
    const parsed = parseSdltm(
      sdltm({
        omitTables: ['translation_unit_contexts', 'attributes', 'string_attributes'],
        units: [{ source: textSegment('Hello'), target: textSegment('Hola', 'es-MX') }],
      }),
    );
    expect(parsed.units).toHaveLength(1);
    expect(parsed.warnings.join('\n')).toMatch(/no translation_unit_contexts table/);
    expect(parsed.warnings.join('\n')).toMatch(/custom fields are not imported/);
  });

  it('warns rather than throwing when an optional unit column is missing', () => {
    const parsed = parseSdltm(
      sdltm({
        omitUnitColumns: ['usage_counter'],
        units: [{ source: textSegment('Hello'), target: textSegment('Hola', 'es-MX') }],
      }),
    );
    expect(parsed.units[0]!.usageCount).toBeUndefined();
    expect(parsed.warnings.join('\n')).toMatch(/no "usage_counter" column/);
  });

  it('throws when a column it cannot work without is missing', () => {
    const broken = createSyntheticSdltm();
    broken.exec('DROP TABLE translation_units');
    broken.exec('CREATE TABLE translation_units (id INTEGER PRIMARY KEY, segment TEXT)');
    try {
      expect(() => parseSdltm(broken)).toThrow(/missing required column/);
    } finally {
      broken.close();
    }
  });

  it('scopes units to the first memory, and says so, when a file holds several', () => {
    const parsed = parseSdltm(
      sdltm({
        name: 'first',
        extraMemories: [{ name: 'second' }],
        units: [{ source: textSegment('Hello'), target: textSegment('Hola', 'es-MX') }],
      }),
    );
    expect(parsed.name).toBe('first');
    expect(parsed.units).toHaveLength(1);
    expect(parsed.warnings.join('\n')).toMatch(/holds 2 memories/);
  });
});

describe('parseSdltmSegment', () => {
  it('keeps tags and text interleaved in document order', () => {
    // The whole point of the ordered `elements` list: these two segments
    // have identical tag and text arrays and entirely different content.
    const wrapped = parseSdltmSegment(
      segmentXml([{ tag: 'Start', anchor: 1 }, 'Page ', { tag: 'End', anchor: 1 }]),
    );
    const trailing = parseSdltmSegment(
      segmentXml(['Page ', { tag: 'Start', anchor: 1 }, { tag: 'End', anchor: 1 }]),
    );
    expect(wrapped.elements.map((e) => e.kind)).toEqual(['tag', 'text', 'tag']);
    expect(trailing.elements.map((e) => e.kind)).toEqual(['text', 'tag', 'tag']);
    expect(wrapped.tags).toHaveLength(2);
    expect(wrapped.texts).toHaveLength(1);
  });

  it('reads CanHide and the culture name', () => {
    const segment = parseSdltmSegment(
      segmentXml(
        [
          { tag: 'Start', anchor: 1, canHide: true },
          'Page ',
          { tag: 'End', anchor: 1, canHide: true },
        ],
        'en-GB',
      ),
    );
    expect(segment.culture).toBe('en-GB');
    expect(segment.tags.every((t) => t.canHide)).toBe(true);
  });

  it('treats a Start/End with no Anchor as standalone rather than dropping it', () => {
    const segment = parseSdltmSegment(segmentXml([{ tag: 'Start', anchor: null }, 'x']));
    expect(segment.tags).toHaveLength(1);
    expect(segment.tags[0]!.type).toBe('Standalone');
    expect(segment.tags[0]!.rawType).toBe('Start');
  });

  it('decodes predefined and numeric XML entities', () => {
    const segment = parseSdltmSegment(
      `<Segment><Elements><Text><Value>a &lt;b&gt; &amp;amp; &#39;c&#39; &#x2014;</Value></Text></Elements><CultureName>en-US</CultureName></Segment>`,
    );
    // The em dash goes in as an escape, never a bare glyph — an editor or a
    // copy-paste can silently re-mangle the glyph, which is the whole reason
    // §4's normalisation list spells its codepoints out (CLAUDE.md).
    expect(segment.texts[0]!.value).toBe("a <b> &amp; 'c' \u2014");
  });

  it('throws on XML that is not a segment', () => {
    expect(() => parseSdltmSegment('<NotASegment/>')).toThrow(SdltmError);
  });

  it('accepts a self-closing empty Elements block', () => {
    const segment = parseSdltmSegment(
      '<Segment><Elements /><CultureName>es-MX</CultureName></Segment>',
    );
    expect(segment.elements).toHaveLength(0);
    expect(segment.culture).toBe('es-MX');
  });
});

describe('parseSdltm — unit extraction', () => {
  it('parses a bilingual unit with its usage metadata', () => {
    const parsed = parseSdltm(
      sdltm({
        units: [
          {
            source: textSegment('Hello world'),
            target: textSegment('Hola mundo', 'es-MX'),
            usageCounter: 5,
          },
        ],
      }),
    );
    expect(parsed.units).toHaveLength(1);
    const unit = parsed.units[0]!;
    expect(unit.sourceLang).toBe('en-US');
    expect(unit.targetLang).toBe('es-MX');
    expect(unit.usageCount).toBe(5);
    expect(unit.id).toBeGreaterThan(0);
  });

  it('keeps every context occurrence, in order', () => {
    const parsed = parseSdltm(
      sdltm({
        units: [
          {
            source: textSegment('Test'),
            target: textSegment('Prueba', 'es-MX'),
            contexts: [
              { source: '1741029398', target: '885211174' },
              { source: '992113044', target: '221190443' },
            ],
          },
        ],
      }),
    );
    expect(parsed.units[0]!.contexts).toHaveLength(2);
    expect(parsed.units[0]!.contexts[0]!.leftSourceContext).toBe('1741029398');
    expect(parsed.units[0]!.contexts[1]!.leftTargetContext).toBe('221190443');
  });

  it('preserves Trados custom fields', () => {
    const parsed = parseSdltm(
      sdltm({
        units: [
          {
            source: textSegment('Test'),
            target: textSegment('Prueba', 'es-MX'),
            attributes: [
              { name: 'SourceFile', value: 'handbook.docx' },
              { name: 'StructureContext', value: 'paragraph' },
            ],
          },
        ],
      }),
    );
    expect(parsed.units[0]!.attributes).toEqual([
      { key: 'SourceFile', value: 'handbook.docx' },
      { key: 'StructureContext', value: 'paragraph' },
    ]);
  });

  it('maps timestamps and users, reading a space-separated stamp as UTC', () => {
    const parsed = parseSdltm(
      sdltm({
        units: [
          {
            source: textSegment('Test'),
            target: textSegment('Prueba', 'es-MX'),
            usageCounter: 10,
            lastUsedDate: '2026-03-04 09:15:22',
            creationDate: '2024-01-02',
            changeDate: '2026-03-04T09:15:22.500Z',
            creationUser: 'translator_1',
            changeUser: 'reviewer_2',
          },
        ],
      }),
    );
    const unit = parsed.units[0]!;
    expect(unit.usageCount).toBe(10);
    expect(unit.lastUsedAt).toBe('2026-03-04T09:15:22.000Z');
    expect(unit.createdAt).toBe('2024-01-02T00:00:00.000Z');
    expect(unit.updatedAt).toBe('2026-03-04T09:15:22.500Z');
    expect(unit.createdBy).toBe('translator_1');
    expect(unit.updatedBy).toBe('reviewer_2');
  });

  it('reports an unreadable date once per column, not once per unit', () => {
    const parsed = parseSdltm(
      sdltm({
        units: Array.from({ length: 40 }, (_, i) => ({
          source: textSegment(`Unit ${i}`),
          target: textSegment(`Unidad ${i}`, 'es-MX'),
          creationDate: 'whenever',
        })),
      }),
    );
    const dateWarnings = parsed.warnings.filter((w) => w.includes('creation_date'));
    expect(dateWarnings).toEqual([
      '40 unit(s) have an unreadable creation_date — left unset',
    ]);
    expect(parsed.units[0]!.createdAt).toBeUndefined();
  });

  it('reports unparseable segments once per cause, not once per unit', () => {
    const parsed = parseSdltm(
      sdltm({
        units: Array.from({ length: 25 }, () => ({
          source: 'not xml at all',
          target: textSegment('Prueba', 'es-MX'),
        })),
      }),
    );
    expect(parsed.units).toHaveLength(0);
    const skipped = parsed.warnings.filter((w) => w.includes('skipped'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/^25 unit\(s\) skipped/);
  });

  it('reports a tag type it has never seen once per type', () => {
    const parsed = parseSdltm(
      sdltm({
        units: Array.from({ length: 12 }, () => ({
          source: segmentXml([{ tag: 'LockedContent', anchor: null }, 'x']),
          target: textSegment('x', 'es-MX'),
        })),
      }),
    );
    const odd = parsed.warnings.filter((w) => w.includes('LockedContent'));
    expect(odd).toHaveLength(1);
    expect(odd[0]).toMatch(/^12 tag\(s\)/);
    expect(odd[0]).toMatch(/carried as a placeholder rather than dropped/);
  });
});

describe('parseSdltm — what a real file turned out to hold', () => {
  // Every case below came off one real 2013 client memory, the first
  // real `.sdltm` this reader was ever pointed at. None of them could have
  // been produced by a fixture built from the Studio 8.06 schema, because
  // that schema is what the fixture was built from — which is the whole
  // reason backlog #18b insisted a real file was still owed.

  it('reads a signed 64-bit context hash without losing digits', () => {
    // The value is real. Read as a JS number, `better-sqlite3` returns
    // -8331597179047842000 and says nothing; `node:sqlite` throws outright.
    const parsed = parseSdltm(
      sdltm({
        units: [
          {
            source: textSegment('Hello'),
            target: textSegment('Hola', 'es-MX'),
            contexts: [{ source: '-8331597179047842233', target: '7705199483498372611' }],
          },
        ],
      }),
    );
    const context = parsed.units[0]!.contexts[0]!;
    expect(context.leftSourceContext).toBe('-8331597179047842233');
    expect(context.leftTargetContext).toBe('7705199483498372611');
    // Named explicitly, because a JS number literal cannot express the
    // difference: -8331597179047842233 written in source *is* already
    // -8331597179047842000. Only the string form can tell them apart, which
    // is why the value is carried as a string at all.
    expect(context.leftSourceContext).not.toBe('-8331597179047842000');
  });

  it('reads a memory whose string_attributes table has no id column', () => {
    const parsed = parseSdltm(
      sdltm({
        omitStringAttributeId: true,
        units: [
          {
            source: textSegment('Hello'),
            target: textSegment('Hola', 'es-MX'),
            attributes: [{ name: 'SourceFile', value: 'bulletin.docx' }],
          },
        ],
      }),
    );
    expect(parsed.units[0]!.attributes).toEqual([
      { key: 'SourceFile', value: 'bulletin.docx' },
    ]);
  });

  it('ignores the tables Studio keeps that this reader knows nothing about', () => {
    // A 2013 memory carries seven tables §8a never recorded — among them
    // `fuzzy_data`, one row per unit, contents unexamined. Whatever they
    // hold, their presence must not disturb the read.
    const db = createSyntheticSdltm({
      units: [{ source: textSegment('Hello'), target: textSegment('Hola', 'es-MX') }],
    });
    for (const table of [
      'fuzzy_data',
      'date_attributes',
      'numeric_attributes',
      'picklist_attributes',
      'picklist_values',
      'resources',
      'tm_resources',
    ]) {
      db.exec(`CREATE TABLE ${table} (translation_unit_id INTEGER, payload BLOB)`);
    }
    db.exec("INSERT INTO fuzzy_data VALUES (1, x'deadbeef')");
    try {
      const parsed = parseSdltm(db);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.warnings.join('\n')).not.toMatch(/fuzzy_data/);
    } finally {
      db.close();
    }
  });

  it('leaves a usage count it cannot represent unset rather than wrong', () => {
    const db = createSyntheticSdltm({
      units: [{ source: textSegment('Hello'), target: textSegment('Hola', 'es-MX') }],
    });
    db.exec('UPDATE translation_units SET usage_counter = 9007199254740993');
    try {
      expect(parseSdltm(db).units[0]!.usageCount).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('sdltmDateToIso', () => {
  it('reads a space-separated stamp as UTC, never local time', () => {
    expect(sdltmDateToIso('2026-03-04 09:15:22')).toBe('2026-03-04T09:15:22.000Z');
  });

  it('keeps milliseconds', () => {
    expect(sdltmDateToIso('2026-03-04T09:15:22.857Z')).toBe('2026-03-04T09:15:22.857Z');
  });

  it('accepts a bare date', () => {
    expect(sdltmDateToIso('2026-03-04')).toBe('2026-03-04T00:00:00.000Z');
  });

  it('returns undefined for absent or unreadable values', () => {
    expect(sdltmDateToIso(null)).toBeUndefined();
    expect(sdltmDateToIso('   ')).toBeUndefined();
    expect(sdltmDateToIso('whenever')).toBeUndefined();
  });
});
