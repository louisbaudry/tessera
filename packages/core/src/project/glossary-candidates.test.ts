/**
 * Candidate extraction against real document structure (backlog #40).
 * In `project/` because it needs both a segmented file and the glossary —
 * the layer above each (CLAUDE.md, `core`'s layering).
 *
 * The fixtures' words are synthetic (`fixtures/docx/README.md`), so what
 * repeats in them is the synthesiser's doing and no term here is a real
 * one: this proves the properties that hold for any text, at the scale
 * of a real document, and nothing about which terms a manuscript has.
 * Which honorifics and place names a real one yields is the unit tests'
 * sentences (`glossary/candidates.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractCandidates } from '../glossary/candidates.js';
import { stopwordsFor } from '../glossary/stopwords.js';
import type { Segment } from '../model/segment.js';
import { rulesFor } from '../segment/rules.js';
import { assembleFile } from './assemble.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

function segmentsOf(name: string, lang: string): Segment[] {
  const assembled = assembleFile(
    new Uint8Array(readFileSync(join(FIXTURES, name))),
    rulesFor(lang),
  );
  return assembled.segments.map((s, i) => ({
    ...s,
    id: i + 1,
    fileId: 1,
    targetTokens: null,
    origin: null,
    updatedAt: '2026-10-02T00:00:00.000Z',
  }));
}

describe.each([
  ['footnotes-manuscript.docx', 'es'],
  ['prose-long.docx', 'en'],
])('extractCandidates on %s (%s)', (name, lang) => {
  const segments = segmentsOf(name, lang);
  const candidates = extractCandidates(segments, { srcLang: lang });
  const stop = stopwordsFor(lang);

  it('finds repeated terms in a real file', () => {
    expect(segments.length).toBeGreaterThan(100);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('never begins or ends a term on a stopword, or runs over three words', () => {
    for (const c of candidates) {
      const words = c.key.split(/\s+/);
      expect(words.length, c.key).toBeLessThanOrEqual(3);
      expect(stop.has(words[0]!), c.key).toBe(false);
      expect(stop.has(words[words.length - 1]!), c.key).toBe(false);
    }
  });

  it('only names segments that exist, ascending, and only repeated terms', () => {
    const ords = new Set(segments.map((s) => s.ord));
    for (const c of candidates) {
      expect(c.occurrences, c.key).toBeGreaterThanOrEqual(3);
      expect(
        c.ords.every((o) => ords.has(o)),
        c.key,
      ).toBe(true);
      expect(
        [...c.ords].sort((a, b) => a - b),
        c.key,
      ).toEqual(c.ords);
    }
  });

  it('is the same every run', () => {
    expect(extractCandidates(segments, { srcLang: lang })).toEqual(candidates);
  });
});
