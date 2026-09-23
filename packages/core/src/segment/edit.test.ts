import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importDocx, translatableSegments } from '../docx/document.js';
import { renderRegion } from '../docx/render.js';
import {
  tokenizeRegion,
  tokensText,
  type FormatEntry,
  type TokenizedRegion,
} from '../docx/tokenize.js';
import { validateTagStructure } from '../model/tags.js';
import { plainText } from '../model/token.js';
import {
  mergeEditableSegments,
  mergeSegments,
  SegmentEditError,
  splitEditableSegment,
  splitSegment,
  type EditableSegment,
} from './edit.js';
import { rulesFor } from './rules.js';
import { segmentTokens } from './segmenter.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const plain = (xml: string): TokenizedRegion => tokenizeRegion(xml);

const ITALIC = '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">';
const BOLD = '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">';

describe('splitSegment', () => {
  it('splits plain text at the offset', () => {
    const [a, b] = splitSegment(plain('<w:r><w:t>Hello world</w:t></w:r>'), 6);
    expect(plainText(a.tokens)).toBe('Hello ');
    expect(plainText(b.tokens)).toBe('world');
  });

  it('rejects offsets outside the interior', () => {
    const region = plain('<w:r><w:t>Hello</w:t></w:r>');
    for (const offset of [0, 5, 7, -1, 2.5]) {
      expect(() => splitSegment(region, offset)).toThrow(SegmentEditError);
    }
  });

  it('rejects a split that leaves only whitespace on one side', () => {
    const region = plain('<w:r><w:t xml:space="preserve">Hello   </w:t></w:r>');
    expect(() => splitSegment(region, 6)).toThrow(SegmentEditError);
  });

  it('closes and reopens a pair spanning the cut, renumbered from 1', () => {
    const region = plain(`${ITALIC}Hello world</w:t></w:r>`);
    const [a, b] = splitSegment(region, 6);
    for (const half of [a, b]) {
      expect(validateTagStructure(half.tokens)).toEqual({ ok: true });
      expect(half.formats).toHaveLength(1);
      expect(half.formats[0]!.id).toBe(1);
      expect(half.formats[0]!.kind).toBe('i');
    }
    expect(plainText(a.tokens)).toBe('Hello ');
    expect(plainText(b.tokens)).toBe('world');
  });

  it('keeps a trailing placeholder with the text it annotates', () => {
    const ref: FormatEntry = {
      id: 1,
      kind: 'footnote',
      visible: true,
      placement: 'in-run',
      open: '<w:footnoteReference w:id="2"/>',
      close: '',
    };
    const region: TokenizedRegion = {
      tokens: [
        { t: 'text', v: 'One.' },
        { t: 'ph', id: 1, fmt: 1 },
        { t: 'text', v: ' Two' },
      ],
      formats: [ref],
    };
    const [a, b] = splitSegment(region, 4);
    expect(a.tokens.some((t) => t.t === 'ph')).toBe(true);
    expect(b.tokens.some((t) => t.t === 'ph')).toBe(false);
    expect(plainText(b.tokens)).toBe(' Two');
  });
});

describe('mergeSegments', () => {
  it('merging a split reproduces the original exactly', () => {
    for (const xml of [
      '<w:r><w:t>Hello world</w:t></w:r>',
      `${ITALIC}Hello world</w:t></w:r>`,
      `<w:r><w:t>One thing. </w:t></w:r>${BOLD}Bold two.</w:t></w:r>`,
    ]) {
      const region = plain(xml);
      const [a, b] = splitSegment(region, 6);
      expect(mergeSegments(a, b)).toEqual(region);
    }
  });

  it('keeps genuinely different pairs separate', () => {
    const a = plain(`${ITALIC}Hola.</w:t></w:r>`);
    const b = plain(`${BOLD}Adiós.</w:t></w:r>`);
    const merged = mergeSegments(a, b, { separator: ' ' });
    expect(plainText(merged.tokens)).toBe('Hola. Adiós.');
    expect(merged.formats).toHaveLength(2);
    expect(validateTagStructure(merged.tokens)).toEqual({ ok: true });
  });

  it('adds the separator only when neither side brings whitespace', () => {
    const a = plain('<w:r><w:t xml:space="preserve">One. </w:t></w:r>');
    const b = plain('<w:r><w:t>Two.</w:t></w:r>');
    expect(plainText(mergeSegments(a, b, { separator: ' ' }).tokens)).toBe('One. Two.');
    const c = plain('<w:r><w:t>One.</w:t></w:r>');
    expect(plainText(mergeSegments(c, b, { separator: ' ' }).tokens)).toBe('One. Two.');
    expect(plainText(mergeSegments(c, b).tokens)).toBe('One.Two.');
  });
});

describe('editable segments — the policy layer', () => {
  const seg = (
    source: string,
    target: string | null,
    status: EditableSegment['status'] = 'new',
    locked = false,
  ): EditableSegment => ({
    source: plain(`<w:r><w:t xml:space="preserve">${source}</w:t></w:r>`),
    target: target ? plain(`<w:r><w:t xml:space="preserve">${target}</w:t></w:r>`) : null,
    status,
    locked,
  });

  it('refuses to touch a locked segment', () => {
    const locked = seg('Hello world', null, 'new', true);
    const other = seg('More.', null);
    expect(() => splitEditableSegment(locked, 6)).toThrow(SegmentEditError);
    expect(() => mergeEditableSegments(locked, other)).toThrow(SegmentEditError);
    expect(() => mergeEditableSegments(other, seg('X.', null, 'locked'))).toThrow(
      SegmentEditError,
    );
  });

  it('split keeps the whole target on the first half, as a draft', () => {
    const [first, second] = splitEditableSegment(
      seg('One thing. Another.', 'Una cosa. Otra.', 'confirmed'),
      11,
    );
    expect(plainText(first.source.tokens)).toBe('One thing. ');
    expect(plainText(first.target!.tokens)).toBe('Una cosa. Otra.');
    expect(first.status).toBe('draft'); // never stays confirmed
    expect(second.target).toBeNull();
    expect(second.status).toBe('new');
  });

  it('split of an untranslated segment yields two new segments', () => {
    const [first, second] = splitEditableSegment(seg('One thing. Another.', null), 11);
    expect(first.status).toBe('new');
    expect(second.status).toBe('new');
  });

  it('merge joins two targets with a space and demotes to draft', () => {
    const merged = mergeEditableSegments(
      seg('One. ', 'Uno.', 'confirmed'),
      seg('Two.', 'Dos.', 'translated'),
    );
    expect(plainText(merged.source.tokens)).toBe('One. Two.');
    expect(plainText(merged.target!.tokens)).toBe('Uno. Dos.');
    expect(merged.status).toBe('draft');
  });

  it('merge keeps a lone target and stays new with none', () => {
    const one = mergeEditableSegments(seg('One. ', 'Uno.'), seg('Two.', null));
    expect(plainText(one.target!.tokens)).toBe('Uno.');
    expect(one.status).toBe('draft');
    const none = mergeEditableSegments(seg('One. ', null), seg('Two.', null));
    expect(none.target).toBeNull();
    expect(none.status).toBe('new');
  });
});

describe('split and merge — against the real corpus', () => {
  const es = rulesFor('es');
  const paragraphs = translatableSegments(importDocx(load('footnotes-manuscript.docx')))
    .map((s) => ({ where: s.key, region: tokenizeRegion(s.xml) }))
    .map(({ where, region }) => ({ where, segments: segmentTokens(region, es), region }));

  it('split at the midpoint then merge is the identity, everywhere', () => {
    let checked = 0;
    for (const { where, segments } of paragraphs) {
      for (const segment of segments) {
        const middle = Math.floor(plainText(segment.tokens).length / 2);
        let halves: [TokenizedRegion, TokenizedRegion];
        try {
          halves = splitSegment(segment, middle);
        } catch (error) {
          // A midpoint inside trailing whitespace is legitimately refused.
          expect(error).toBeInstanceOf(SegmentEditError);
          continue;
        }
        const merged = mergeSegments(...halves);
        // The invariant that matters is the exported XML: merge emits a
        // normal form (coalesced text; identical adjacent runs fused, as
        // the renderer fuses them anyway), so token streams can differ
        // where the cut fell between two identically-formatted runs —
        // the render must not.
        expect(plainText(merged.tokens), where).toBe(plainText(segment.tokens));
        expect(renderRegion(merged), where).toBe(renderRegion(segment));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('folding a paragraph back together preserves text and structure', () => {
    let multi = 0;
    for (const { where, segments, region } of paragraphs) {
      if (segments.length < 2) continue;
      multi++;
      const merged = segments.reduce((acc, next) => mergeSegments(acc, next));
      expect(validateTagStructure(merged.tokens), where).toEqual({ ok: true });
      expect(() => renderRegion(merged), where).not.toThrow();
      // segmentTokens drops whitespace-only groups, so compare normalised.
      expect(tokensText(merged.tokens).replace(/\s+/g, ' ').trim(), where).toBe(
        tokensText(region.tokens).replace(/\s+/g, ' ').trim(),
      );
    }
    expect(multi).toBeGreaterThan(50);
  });
});
