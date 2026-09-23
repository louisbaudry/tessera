import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderRegion } from '../docx/render.js';
import { isUntranslatable } from '../docx/skeleton.js';
import { validateTagStructure } from '../model/tags.js';
import { rulesFor } from '../segment/rules.js';
import { assembleFile } from './assemble.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

describe('assembleFile', () => {
  it('carries the original bytes through untouched', () => {
    const bytes = load('prose-short.docx');
    const assembled = assembleFile(bytes, rulesFor('en'));
    expect(assembled.originalBlob).toBe(bytes);
  });

  it('produces one part_map entry per skeleton, and nothing else', () => {
    const assembled = assembleFile(load('footnotes-manuscript.docx'), rulesFor('es'));
    expect(assembled.partMap).toEqual(assembled.skeleton.map((s) => s.part));
    expect(new Set(assembled.partMap).size).toBe(assembled.partMap.length);
  });

  it('assigns file-wide, gap-free, ascending ord across every segment', () => {
    const assembled = assembleFile(load('footnotes-manuscript.docx'), rulesFor('es'));
    expect(assembled.segments.map((s) => s.ord)).toEqual(
      assembled.segments.map((_, i) => i),
    );
  });

  it('splits a multi-sentence paragraph into several segments sharing one paraKey', () => {
    // paraKey is only unique *within its part* (skeleton.ts's own
    // contract) — footer1's "s1" and footnotes' "s1" are unrelated
    // paragraphs that happen to share a locally-scoped key, so grouping
    // must key on (part, paraKey), not paraKey alone.
    const assembled = assembleFile(load('footnotes-manuscript.docx'), rulesFor('es'));
    const byPara = new Map<string, number[]>();
    for (const s of assembled.segments) {
      const groupKey = `${s.part}:${s.paraKey}`;
      const list = byPara.get(groupKey) ?? [];
      list.push(s.paraOrd);
      byPara.set(groupKey, list);
    }
    expect([...byPara.values()].some((ords) => ords.length > 1)).toBe(true);
    // paraOrd is 0-based and gap-free within each (part, paraKey) group.
    for (const [key, ords] of byPara) {
      expect(ords, key).toEqual(ords.map((_, i) => i));
    }
  });

  it('marks untranslatable content locked, and everything else new', () => {
    const assembled = assembleFile(load('form-minimal.docx'), rulesFor('en'));
    for (const segment of assembled.segments) {
      if (segment.locked) {
        expect(segment.status).toBe('locked');
      } else {
        expect(segment.status).toBe('new');
      }
    }
    expect(assembled.segments.some((s) => s.locked)).toBe(true);
    expect(assembled.segments.some((s) => !s.locked)).toBe(true);
  });

  it('never sentence-splits untranslatable content', () => {
    const assembled = assembleFile(load('form-minimal.docx'), rulesFor('en'));
    for (const segment of assembled.segments) {
      if (segment.locked) expect(segment.paraOrd).toBe(0);
    }
  });

  it('every segment has a valid tag structure and renders', () => {
    const assembled = assembleFile(load('footnotes-manuscript.docx'), rulesFor('es'));
    for (const segment of assembled.segments) {
      expect(validateTagStructure(segment.sourceTokens)).toEqual({ ok: true });
      expect(() =>
        renderRegion({ tokens: segment.sourceTokens, formats: segment.formatTable }),
      ).not.toThrow();
    }
  });

  it('every source_hash is a lowercase hex SHA-256 digest', () => {
    const assembled = assembleFile(load('prose-short.docx'), rulesFor('en'));
    for (const segment of assembled.segments) {
      expect(segment.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('two segments with identical text hash the same', () => {
    const assembled = assembleFile(load('footnotes-manuscript.docx'), rulesFor('es'));
    const byHash = new Map<string, number>();
    for (const s of assembled.segments) {
      byHash.set(s.sourceHash, (byHash.get(s.sourceHash) ?? 0) + 1);
    }
    // A manuscript this size has real repetition (headers, boilerplate).
    expect([...byHash.values()].some((n) => n > 1)).toBe(true);
  });

  it('produces the same DocPart classification isUntranslatable would agree with', () => {
    // Not a redundant check: this asserts the locked/untranslatable
    // segments assembleFile emits line up with the skeleton's own
    // regions, not just that *some* segments happen to be locked.
    const assembled = assembleFile(load('form-minimal.docx'), rulesFor('en'));
    let untranslatableRegions = 0;
    for (const part of assembled.skeleton) {
      for (const region of part.regions) {
        if (isUntranslatable(region)) untranslatableRegions++;
      }
    }
    const lockedSegments = assembled.segments.filter((s) => s.locked).length;
    expect(lockedSegments).toBe(untranslatableRegions);
  });
});
