import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  DocxError,
  getPart,
  readDocx,
  replacePart,
  translatableParts,
  writeDocx,
  type DocxPackage,
} from './package.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.docx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

/**
 * Compare binary parts by digest, never with toEqual().
 *
 * Deep equality on a multi-megabyte Uint8Array walks it element by element
 * and takes tens of seconds per fixture; the corpus includes 2.8 MB files.
 * Hashing is O(n) and the failure message stays readable.
 */
const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** Part name -> digest of its bytes, for whole-package comparison. */
function partMap(pkg: DocxPackage): Map<string, string> {
  return new Map(pkg.parts.map((p) => [p.name, digest(p.data)]));
}

describe('fixtures', () => {
  it('finds the corpus', () => {
    // Guards against a silently-empty suite if the path ever moves.
    expect(fixtureNames.length).toBeGreaterThanOrEqual(21);
  });
});

describe('readDocx', () => {
  it.each(fixtureNames)('reads %s', (name) => {
    const pkg = readDocx(load(name));
    expect(pkg.parts.length).toBeGreaterThan(0);
    expect(getPart(pkg, '[Content_Types].xml')).toBeDefined();
    expect(getPart(pkg, 'word/document.xml')).toBeDefined();
  });

  it('rejects bytes that are not a ZIP', () => {
    expect(() => readDocx(new TextEncoder().encode('not a zip'))).toThrow(DocxError);
  });

  it('rejects a ZIP that is not a DOCX', () => {
    const zip = zipSync({ 'hello.txt': new Uint8Array([1, 2, 3]) });
    expect(() => readDocx(zip)).toThrow(/missing required part/);
  });
});

describe('roundtrip byte fidelity', () => {
  // The gate this module exists for: read -> write -> read must reproduce
  // every part's decompressed bytes exactly, for every real-world fixture.
  it.each(fixtureNames)('%s survives read -> write -> read', (name) => {
    const original = readDocx(load(name));
    const rewritten = readDocx(writeDocx(original));

    expect(rewritten.parts.map((p) => p.name)).toEqual(original.parts.map((p) => p.name));
    expect(partMap(rewritten)).toEqual(partMap(original));
  });

  it('preserves parts a naive implementation would discard', () => {
    // prose-long carries an unreferenced [trash]/0000.dat left behind by
    // some tool. Real documents carry debris; dropping it is not a
    // cleanup, it is a corrupted roundtrip.
    const pkg = readDocx(load('prose-long.docx'));
    expect(pkg.parts.some((p) => p.name.startsWith('[trash]/'))).toBe(true);
    const after = readDocx(writeDocx(pkg));
    expect(after.parts.some((p) => p.name.startsWith('[trash]/'))).toBe(true);
  });

  it('preserves embedded font binaries', () => {
    const pkg = readDocx(load('embedded-fonts.docx'));
    const fonts = pkg.parts.filter((p) => p.name.startsWith('word/fonts/'));
    expect(fonts.length).toBe(5);
    const after = readDocx(writeDocx(pkg));
    for (const font of fonts) {
      expect(digest(getPart(after, font.name)!)).toBe(digest(font.data));
    }
  });

  it('preserves image binaries', () => {
    const pkg = readDocx(load('media-heavy-packet.docx'));
    const media = pkg.parts.filter((p) => p.name.startsWith('word/media/'));
    expect(media.length).toBeGreaterThan(0);
    const after = readDocx(writeDocx(pkg));
    for (const item of media) {
      expect(digest(getPart(after, item.name)!)).toBe(digest(item.data));
    }
  });
});

describe('replacePart', () => {
  it('changes one part and leaves the rest identical', () => {
    const pkg = readDocx(load('prose-short.docx'));
    const replacement = new TextEncoder().encode('<w:document/>');
    const next = replacePart(pkg, 'word/document.xml', replacement);

    expect(getPart(next, 'word/document.xml')).toEqual(replacement);
    expect(next.parts.map((p) => p.name)).toEqual(pkg.parts.map((p) => p.name));
    for (const part of pkg.parts) {
      if (part.name === 'word/document.xml') continue;
      expect(digest(getPart(next, part.name)!)).toBe(digest(part.data));
    }
  });

  it('does not mutate the original package', () => {
    const pkg = readDocx(load('prose-short.docx'));
    const before = digest(getPart(pkg, 'word/document.xml')!);
    replacePart(pkg, 'word/document.xml', new Uint8Array([0]));
    expect(digest(getPart(pkg, 'word/document.xml')!)).toBe(before);
  });

  it('throws rather than adding an absent part', () => {
    const pkg = readDocx(load('prose-short.docx'));
    expect(() => replacePart(pkg, 'word/nope.xml', new Uint8Array())).toThrow(
      /absent part/,
    );
  });
});

describe('translatableParts', () => {
  it('finds the body, and only real parts', () => {
    const pkg = readDocx(load('prose-short.docx'));
    expect(translatableParts(pkg)).toContain('word/document.xml');
    expect(translatableParts(pkg)).not.toContain('word/styles.xml');
  });

  it('finds footnotes and every footer in the manuscript', () => {
    // 10 footers plus footnotes/endnotes is what forced skeletons to be
    // per part rather than per document (planning/v1-spec.md §3.5).
    const parts = translatableParts(readDocx(load('footnotes-manuscript.docx')));
    expect(parts).toContain('word/footnotes.xml');
    expect(parts.filter((p) => /footer\d+\.xml$/.test(p))).toHaveLength(10);
  });

  it('does not mistake footnotes.xml.rels for a translatable part', () => {
    const parts = translatableParts(readDocx(load('footnotes-manuscript.docx')));
    expect(parts.every((p) => !p.endsWith('.rels'))).toBe(true);
  });
});
