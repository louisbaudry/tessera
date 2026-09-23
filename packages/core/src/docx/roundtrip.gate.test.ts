/**
 * 🚦 THE ROUNDTRIP GATE — backlog #8.
 *
 * Import every real client document and export it again without changing a
 * single word. Every part must come back byte-identical.
 *
 * This is not a nice-to-have test. If the filter cannot return an
 * *unmodified* document unchanged, it cannot return a *translated* one
 * safely either — and the failure mode is a client discovering broken
 * formatting weeks after delivery. Nothing in Epic 5+ (the editor) starts
 * until this is green, and it is wired as a required CI check so it cannot
 * silently regress.
 *
 * Kept in its own file, and its own CI job, so a failure here is
 * unmistakable rather than one red dot among a hundred unit tests.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  documentSegments,
  exportDocx,
  importDocx,
  translatableSegments,
} from './document.js';
import { readDocx, type DocxPackage } from './package.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.docx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

// Deep equality on multi-megabyte Uint8Arrays is pathologically slow; the
// corpus includes 2.8 MB files. Compare by digest.
const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

const partDigests = (pkg: DocxPackage): Map<string, string> =>
  new Map(pkg.parts.map((p) => [p.name, digest(p.data)]));

describe('🚦 roundtrip gate', () => {
  it('has a corpus to run against', () => {
    // A silently-empty gate would pass forever and prove nothing.
    expect(fixtureNames.length).toBeGreaterThanOrEqual(21);
  });

  it.each(fixtureNames)('%s: import → export changes nothing', (name) => {
    const original = readDocx(load(name));
    const exported = readDocx(exportDocx(importDocx(load(name))));

    // Same parts, same order. A dropped part is a corrupted document even
    // when every remaining byte matches.
    expect(
      exported.parts.map((p) => p.name),
      `${name}: part list`,
    ).toEqual(original.parts.map((p) => p.name));

    // Compare per part so a failure names the part that broke, rather than
    // reporting that two multi-megabyte blobs differ somewhere.
    const before = partDigests(original);
    const after = partDigests(exported);
    for (const [part, hash] of before) {
      expect(after.get(part), `${name} :: ${part}`).toBe(hash);
    }
  });

  it.each(fixtureNames)('%s: export is idempotent', (name) => {
    // Exporting twice must not drift. Drift here would mean each save of a
    // long job degrades the document a little further.
    const once = exportDocx(importDocx(load(name)));
    const twice = exportDocx(importDocx(once));
    expect(partDigests(readDocx(twice))).toEqual(partDigests(readDocx(once)));
  });

  it.each(fixtureNames)('%s: segments survive the roundtrip', (name) => {
    const before = documentSegments(importDocx(load(name)));
    const after = documentSegments(importDocx(exportDocx(importDocx(load(name)))));
    expect(after.map((s) => s.text)).toEqual(before.map((s) => s.text));
    expect(after.map((s) => s.part)).toEqual(before.map((s) => s.part));
  });
});

describe('🚦 gate is not vacuous', () => {
  // A roundtrip test that passes because nothing is ever extracted would be
  // worthless. These assert the pipeline is actually doing work.

  it('extracts translatable segments from every fixture with text', () => {
    for (const name of fixtureNames) {
      const segments = translatableSegments(importDocx(load(name)));
      // image-heavy is mostly drawings, but even it carries some text.
      expect(segments.length, `${name}`).toBeGreaterThan(0);
    }
  });

  it('a changed segment actually changes the output', () => {
    const doc = importDocx(load('prose-short.docx'));
    const target = translatableSegments(doc)[0]!;
    const out = exportDocx(
      doc,
      new Map([
        [target.part, new Map([[target.key, '<w:r><w:t>REEMPLAZADO</w:t></w:r>']])],
      ]),
    );
    const reimported = importDocx(out);
    const texts = documentSegments(reimported).map((s) => s.text);
    expect(texts).toContain('REEMPLAZADO');
    expect(texts).not.toContain(target.text);
  });

  it('changing one segment leaves every other part untouched', () => {
    const bytes = load('footnotes-manuscript.docx');
    const doc = importDocx(bytes);
    const target = translatableSegments(doc).find(
      (s) => s.part === 'word/footnotes.xml',
    )!;
    const out = exportDocx(
      doc,
      new Map([[target.part, new Map([[target.key, '<w:r><w:t>nota</w:t></w:r>']])]]),
    );

    const before = partDigests(readDocx(exportDocx(doc)));
    const after = partDigests(readDocx(out));
    const changed = [...before.keys()].filter((p) => before.get(p) !== after.get(p));
    expect(changed).toEqual(['word/footnotes.xml']);
  });
});

describe('🚦 the cases that break naive implementations', () => {
  it('preserves an unreferenced part rather than tidying it away', () => {
    // prose-long carries [trash]/0000.dat. Deleting it looks like a
    // cleanup and is a corrupted roundtrip.
    const exported = readDocx(exportDocx(importDocx(load('prose-long.docx'))));
    expect(exported.parts.some((p) => p.name.startsWith('[trash]/'))).toBe(true);
  });

  it('preserves embedded fonts byte for byte', () => {
    const original = readDocx(load('embedded-fonts.docx'));
    const exported = readDocx(exportDocx(importDocx(load('embedded-fonts.docx'))));
    const fonts = original.parts.filter((p) => p.name.startsWith('word/fonts/'));
    expect(fonts).toHaveLength(5);
    const after = partDigests(exported);
    for (const font of fonts) {
      expect(after.get(font.name)).toBe(digest(font.data));
    }
  });

  it('preserves the ten footers of the manuscript', () => {
    const doc = importDocx(load('footnotes-manuscript.docx'));
    const footers = doc.skeletons.filter((s) => /footer\d+\.xml$/.test(s.part));
    expect(footers).toHaveLength(10);
  });

  it('preserves mc:AlternateContent markup', () => {
    // media-heavy-packet wraps numPicBullet in mc:AlternateContent, which
    // strict XSD does not model. It must survive regardless.
    const exported = readDocx(exportDocx(importDocx(load('media-heavy-packet.docx'))));
    const numbering = exported.parts.find((p) => p.name === 'word/numbering.xml')!;
    expect(new TextDecoder().decode(numbering.data)).toContain('mc:AlternateContent');
  });

  it('preserves tracked changes', () => {
    const exported = readDocx(
      exportDocx(importDocx(load('tracked-changes-endnotes.docx'))),
    );
    const doc = exported.parts.find((p) => p.name === 'word/document.xml')!;
    expect(new TextDecoder().decode(doc.data)).toContain('<w:del ');
  });

  it('orders note bodies after body text', () => {
    // Spec §3.5: the editor should present the document then its notes,
    // not interleave them mid-sentence.
    const segments = documentSegments(importDocx(load('footnotes-manuscript.docx')));
    const lastBody = segments.findLastIndex((s) => s.part === 'word/document.xml');
    const firstNote = segments.findIndex((s) => s.part === 'word/footnotes.xml');
    expect(firstNote).toBeGreaterThan(lastBody);
  });
});
