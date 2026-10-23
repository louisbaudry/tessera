/**
 * 🚦 THE PPTX ROUNDTRIP GATE (planning/v1-spec.md §3.9; issue #169).
 *
 * The DOCX gate's sibling: import every deck and export it again without
 * changing a word, and every part must come back byte-identical. Its own file
 * (named `gate.test`, so `pnpm test:gate` and its CI job run it with the DOCX
 * one) so a failure here is unmistakable.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readPptx, type DocxPackage } from '../docx/package.js';
import { exportPptx, importPptx, pptxSegments } from './document.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/pptx',
);
const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.pptx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const partDigests = (pkg: DocxPackage): Map<string, string> =>
  new Map(pkg.parts.map((p) => [p.name, digest(p.data)]));

describe('🚦 PPTX roundtrip gate', () => {
  it('has a corpus to run against', () => {
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it.each(names)('%s: import → export changes nothing', (name) => {
    const original = readPptx(load(name));
    const exported = readPptx(exportPptx(importPptx(load(name))));
    expect(
      exported.parts.map((p) => p.name),
      `${name}: part list`,
    ).toEqual(original.parts.map((p) => p.name));
    const before = partDigests(original);
    const after = partDigests(exported);
    for (const [part, hash] of before) {
      expect(after.get(part), `${name} :: ${part}`).toBe(hash);
    }
  });

  it.each(names)('%s: export is idempotent', (name) => {
    const once = exportPptx(importPptx(load(name)));
    const twice = exportPptx(importPptx(once));
    expect(partDigests(readPptx(twice))).toEqual(partDigests(readPptx(once)));
  });

  it.each(names)('%s: segments survive the roundtrip', (name) => {
    const before = pptxSegments(importPptx(load(name)));
    const after = pptxSegments(importPptx(exportPptx(importPptx(load(name)))));
    expect(after.map((s) => s.text)).toEqual(before.map((s) => s.text));
    expect(after.map((s) => s.part)).toEqual(before.map((s) => s.part));
  });
});

describe('🚦 the PPTX gate is not vacuous', () => {
  it.each(names)('%s: extracts text', (name) => {
    const segments = pptxSegments(importPptx(load(name))).filter(
      (s) => !s.untranslatable,
    );
    expect(segments.length, name).toBeGreaterThan(3);
  });

  it('a changed region changes its part and no other', () => {
    const doc = importPptx(load('lo-deck.en.pptx'));
    const target = pptxSegments(doc).find((s) => s.text === 'Soil and water')!;
    const out = exportPptx(
      doc,
      new Map([
        [target.part, new Map([[target.key, '<a:r><a:t>Suelo y agua</a:t></a:r>']])],
      ]),
    );
    const before = partDigests(readPptx(exportPptx(doc)));
    const after = partDigests(readPptx(out));
    expect([...before.keys()].filter((p) => before.get(p) !== after.get(p))).toEqual([
      target.part,
    ]);
    const texts = pptxSegments(importPptx(out)).map((s) => s.text);
    expect(texts).toContain('Suelo y agua');
    expect(texts).not.toContain('Soil and water');
  });

  it('keeps a part nothing reads, byte for byte (the master, the theme)', () => {
    const original = readPptx(load('lo-deck.en.pptx'));
    const exported = partDigests(
      readPptx(exportPptx(importPptx(load('lo-deck.en.pptx')))),
    );
    for (const part of original.parts.filter((p) =>
      /theme|slideMaster|slideLayout/.test(p.name),
    )) {
      expect(exported.get(part.name), part.name).toBe(digest(part.data));
    }
  });
});
