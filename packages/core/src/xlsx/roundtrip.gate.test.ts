/**
 * 🚦 THE XLSX ROUNDTRIP GATE (planning/v1-spec.md §3.10; issue #169).
 *
 * The DOCX gate's sibling: import every workbook and export it again without
 * changing a word, and every part must come back byte-identical. Its own file
 * (named `gate.test`, so `pnpm test:gate` and its CI job run it with the DOCX
 * one) so a failure here is unmistakable.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readXlsx, type DocxPackage } from '../docx/package.js';
import { exportXlsx, importXlsx, xlsxSegments } from './document.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/xlsx',
);
const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.xlsx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const partDigests = (pkg: DocxPackage): Map<string, string> =>
  new Map(pkg.parts.map((p) => [p.name, digest(p.data)]));

describe('🚦 XLSX roundtrip gate', () => {
  it('has a corpus to run against', () => {
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it.each(names)('%s: import → export changes nothing', (name) => {
    const original = readXlsx(load(name));
    const exported = readXlsx(exportXlsx(importXlsx(load(name))));
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
    const once = exportXlsx(importXlsx(load(name)));
    const twice = exportXlsx(importXlsx(once));
    expect(partDigests(readXlsx(twice))).toEqual(partDigests(readXlsx(once)));
  });

  it.each(names)('%s: segments survive the roundtrip', (name) => {
    const before = xlsxSegments(importXlsx(load(name)));
    const after = xlsxSegments(importXlsx(exportXlsx(importXlsx(load(name)))));
    expect(after.map((s) => s.text)).toEqual(before.map((s) => s.text));
    expect(after.map((s) => s.part)).toEqual(before.map((s) => s.part));
  });
});

describe('🚦 the XLSX gate is not vacuous', () => {
  it.each(names)('%s: extracts text', (name) => {
    const segments = xlsxSegments(importXlsx(load(name))).filter(
      (s) => !s.untranslatable,
    );
    expect(segments.length, name).toBeGreaterThan(3);
  });

  it('a changed string changes the shared strings and no other part', () => {
    const doc = importXlsx(load('lo-book.en.xlsx'));
    const target = xlsxSegments(doc).find((s) => s.text === 'Soil sampling')!;
    const out = exportXlsx(
      doc,
      new Map([[target.part, new Map([[target.key, '<t>Muestreo de suelo</t>']])]]),
    );
    const before = partDigests(readXlsx(exportXlsx(doc)));
    const after = partDigests(readXlsx(out));
    expect([...before.keys()].filter((p) => before.get(p) !== after.get(p))).toEqual([
      'xl/sharedStrings.xml',
    ]);
    const texts = xlsxSegments(importXlsx(out)).map((s) => s.text);
    expect(texts).toContain('Muestreo de suelo');
    expect(texts).not.toContain('Soil sampling');
  });

  it('keeps a part nothing rewrites, byte for byte (the sheets, the styles, a table)', () => {
    for (const name of names) {
      const original = readXlsx(load(name));
      const exported = partDigests(readXlsx(exportXlsx(importXlsx(load(name)))));
      const untouched = original.parts.filter((p) =>
        /worksheets|styles|theme|tables|workbook/.test(p.name),
      );
      expect(untouched.length, name).toBeGreaterThan(2);
      for (const part of untouched) {
        expect(exported.get(part.name), `${name} :: ${part.name}`).toBe(
          digest(part.data),
        );
      }
    }
  });
});
