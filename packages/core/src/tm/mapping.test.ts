import { describe, expect, it } from 'vitest';

import { renderRegion } from '../docx/render.js';
import { tokenizeRegion, type FormatEntry } from '../docx/tokenize.js';
import type { TmToken, Token } from '../model/token.js';
import { remapTmTokens, toTmTokens } from './mapping.js';

describe('toTmTokens', () => {
  it('drops fmt, keeps kind as a hint, renumbers from 1', () => {
    const region = tokenizeRegion(
      '<w:r><w:t xml:space="preserve">Hello </w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>world</w:t></w:r>',
    );
    const tm = toTmTokens(region.tokens, region.formats);
    expect(tm).toEqual([
      { t: 'text', v: 'Hello ' },
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'world' },
      { t: 'close', id: 1 },
    ]);
  });

  it('renumbers multiple tags from 1 in source order regardless of original ids', () => {
    const tokens: Token[] = [
      { t: 'open', id: 7, fmt: 7 },
      { t: 'text', v: 'a' },
      { t: 'close', id: 7 },
      { t: 'open', id: 3, fmt: 3 },
      { t: 'text', v: 'b' },
      { t: 'close', id: 3 },
    ];
    const formats: FormatEntry[] = [
      { id: 7, kind: 'i', visible: true, placement: 'run', open: '', close: '' },
      { id: 3, kind: 'u', visible: true, placement: 'run', open: '', close: '' },
    ];
    expect(toTmTokens(tokens, formats)).toEqual([
      { t: 'open', id: 1, k: 'i' },
      { t: 'text', v: 'a' },
      { t: 'close', id: 1 },
      { t: 'open', id: 2, k: 'u' },
      { t: 'text', v: 'b' },
      { t: 'close', id: 2 },
    ]);
  });

  it('leaves a placeholder without a kind hint if no format entry is found', () => {
    const tokens: Token[] = [{ t: 'ph', id: 1, fmt: 1 }];
    expect(toTmTokens(tokens, [])).toEqual([{ t: 'ph', id: 1, k: undefined }]);
  });
});

describe('remapTmTokens', () => {
  it("applies the receiving document's formatting, not the origin's (the done-when case)", () => {
    // Origin: a target segment written into the TM, its bold plain.
    const origin = tokenizeRegion(
      '<w:r><w:t xml:space="preserve">Hola </w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>mundo</w:t></w:r>',
    );
    const tmTokens = toTmTokens(origin.tokens, origin.formats);

    // Today's document: same *kind* of tag (bold), genuinely different
    // formatting — bold combined with italic, a different run entirely.
    const current = tokenizeRegion(
      '<w:r><w:t xml:space="preserve">Hello </w:t></w:r>' +
        '<w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>world</w:t></w:r>',
    );

    const result = remapTmTokens(tmTokens, current.tokens, current.formats);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const rendered = renderRegion({ tokens: result.tokens, formats: current.formats });
    // The current document's own bold+italic run, not the origin's plain bold.
    expect(rendered).toContain('<w:b/><w:i/>');
    expect(rendered).not.toContain('<w:rPr><w:b/></w:rPr>');
    expect(rendered).toContain('mundo');
  });

  it('maps tags of the same kind in order, not just by kind', () => {
    const tmTokens: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'first' },
      { t: 'close', id: 1 },
      { t: 'text', v: ' ' },
      { t: 'open', id: 2, k: 'b' },
      { t: 'text', v: 'second' },
      { t: 'close', id: 2 },
    ];
    const sourceTokens: Token[] = [
      { t: 'open', id: 10, fmt: 10 },
      { t: 'text', v: 'x' },
      { t: 'close', id: 10 },
      { t: 'text', v: ' ' },
      { t: 'open', id: 20, fmt: 20 },
      { t: 'text', v: 'y' },
      { t: 'close', id: 20 },
    ];
    const formats: FormatEntry[] = [
      { id: 10, kind: 'b', visible: true, placement: 'run', open: '<a>', close: '</a>' },
      { id: 20, kind: 'b', visible: true, placement: 'run', open: '<b>', close: '</b>' },
    ];
    const result = remapTmTokens(tmTokens, sourceTokens, formats);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.tokens).toEqual([
      { t: 'open', id: 10, fmt: 10 },
      { t: 'text', v: 'first' },
      { t: 'close', id: 10 },
      { t: 'text', v: ' ' },
      { t: 'open', id: 20, fmt: 20 },
      { t: 'text', v: 'second' },
      { t: 'close', id: 20 },
    ]);
  });

  it('refuses when a kind occurs a different number of times', () => {
    const tmTokens: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'a' },
      { t: 'close', id: 1 },
      { t: 'open', id: 2, k: 'b' },
      { t: 'text', v: 'b' },
      { t: 'close', id: 2 },
    ];
    const sourceTokens: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'only one' },
      { t: 'close', id: 1 },
    ];
    const formats: FormatEntry[] = [
      { id: 1, kind: 'b', visible: true, placement: 'run', open: '', close: '' },
    ];
    const result = remapTmTokens(tmTokens, sourceTokens, formats);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/"b" pair occurs 2 time\(s\).*1 time\(s\)/);
  });

  it('refuses when the source has a kind the match never uses at all (asymmetric mismatch)', () => {
    const tmTokens: TmToken[] = [{ t: 'text', v: 'plain' }];
    const sourceTokens: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'x' },
      { t: 'close', id: 1 },
    ];
    const formats: FormatEntry[] = [
      { id: 1, kind: 'i', visible: true, placement: 'run', open: '', close: '' },
    ];
    const result = remapTmTokens(tmTokens, sourceTokens, formats);
    expect(result.ok).toBe(false);
  });

  it('refuses a match tag with no kind hint', () => {
    const tmTokens: TmToken[] = [
      { t: 'open', id: 1 }, // no k
      { t: 'text', v: 'x' },
      { t: 'close', id: 1 },
    ];
    const result = remapTmTokens(tmTokens, [], []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/no kind hint/);
  });

  it('refuses a close tag with no matching open', () => {
    const tmTokens: TmToken[] = [{ t: 'close', id: 1 }];
    const result = remapTmTokens(tmTokens, [], []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/no matching open/);
  });

  it('a plain-text match with a plain-text source needs no tags at all', () => {
    const tmTokens: TmToken[] = [{ t: 'text', v: 'Hola mundo' }];
    const result = remapTmTokens(tmTokens, [{ t: 'text', v: 'Hello world' }], []);
    expect(result).toEqual({ ok: true, tokens: [{ t: 'text', v: 'Hola mundo' }] });
  });

  it('maps a placeholder kind (e.g. a line break) the same way as open/close pairs', () => {
    const tmTokens: TmToken[] = [
      { t: 'text', v: 'a' },
      { t: 'ph', id: 1, k: 'br' },
      { t: 'text', v: 'b' },
    ];
    const sourceTokens: Token[] = [
      { t: 'text', v: 'x' },
      { t: 'ph', id: 5, fmt: 5 },
      { t: 'text', v: 'y' },
    ];
    const formats: FormatEntry[] = [
      {
        id: 5,
        kind: 'br',
        visible: true,
        placement: 'in-run',
        open: '<w:br/>',
        close: '',
      },
    ];
    const result = remapTmTokens(tmTokens, sourceTokens, formats);
    expect(result).toEqual({
      ok: true,
      tokens: [
        { t: 'text', v: 'a' },
        { t: 'ph', id: 5, fmt: 5 },
        { t: 'text', v: 'b' },
      ],
    });
  });

  it('never gives a placeholder the id of a pair of the same kind (backlog #29)', () => {
    // `other` is both a run (a colour) and a placeholder (a symbol). A
    // match that puts the symbol first once handed it the run's id, and
    // the run's XML rendered as a placeholder: a <w:r> with no </w:r>.
    const formats: FormatEntry[] = [
      {
        id: 1,
        kind: 'other',
        visible: true,
        placement: 'run',
        open: '<w:r><w:rPr><w:color w:val="FF0000"/></w:rPr>',
        close: '</w:r>',
      },
      {
        id: 2,
        kind: 'other',
        visible: true,
        placement: 'in-run',
        open: '<w:sym w:font="Wingdings" w:char="F0FC"/>',
        close: '',
      },
    ];
    const sourceTokens: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'schedule' },
      { t: 'close', id: 1 },
      { t: 'ph', id: 2, fmt: 2 },
    ];
    const tmTokens: TmToken[] = [
      { t: 'ph', id: 1, k: 'other' },
      { t: 'open', id: 2, k: 'other' },
      { t: 'text', v: 'calendario' },
      { t: 'close', id: 2 },
    ];
    expect(remapTmTokens(tmTokens, sourceTokens, formats)).toEqual({
      ok: true,
      tokens: [
        { t: 'ph', id: 2, fmt: 2 },
        { t: 'open', id: 1, fmt: 1 },
        { t: 'text', v: 'calendario' },
        { t: 'close', id: 1 },
      ],
    });
  });

  it("maps visible tags only: a hidden run of the same kind never takes a visible one's id (backlog #29)", () => {
    // A red run the translator places, then a run holding the paragraph's
    // font, which is carried: both `other`. A memory that learned the
    // carried order — font run outermost — once gave the font run's slot
    // the red run's id, and exported the whole sentence red.
    const formats: FormatEntry[] = [
      {
        id: 1,
        kind: 'other',
        visible: true,
        placement: 'run',
        open: '<w:r><w:rPr><w:color w:val="FF0000"/></w:rPr>',
        close: '</w:r>',
      },
      {
        id: 2,
        kind: 'other',
        visible: false,
        placement: 'run',
        open: '<w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr>',
        close: '</w:r>',
      },
    ];
    const source: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'Warning:' },
      { t: 'close', id: 1 },
      { t: 'open', id: 2, fmt: 2 },
      { t: 'text', v: ' do not open the cover.' },
      { t: 'close', id: 2 },
    ];
    const carried: Token[] = [
      { t: 'open', id: 2, fmt: 2 },
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'Achtung:' },
      { t: 'close', id: 1 },
      { t: 'text', v: ' Abdeckung nicht öffnen.' },
      { t: 'close', id: 2 },
    ];
    const tm = toTmTokens(carried, formats);
    expect(tm).toEqual([
      { t: 'open', id: 1, k: 'other' },
      { t: 'text', v: 'Achtung:' },
      { t: 'close', id: 1 },
      { t: 'text', v: ' Abdeckung nicht öffnen.' },
    ]);
    expect(remapTmTokens(tm, source, formats)).toEqual({
      ok: true,
      tokens: [
        { t: 'open', id: 1, fmt: 1 },
        { t: 'text', v: 'Achtung:' },
        { t: 'close', id: 1 },
        { t: 'text', v: ' Abdeckung nicht öffnen.' },
      ],
    });
  });

  it("maps a unit holding the document's hidden tags too onto all of them, keeping the visible", () => {
    // A unit from another tool, or from before memories dropped hidden
    // tags: a font run the document hides around a bold word.
    const formats: FormatEntry[] = [
      { id: 1, kind: 'other', visible: false, placement: 'run', open: '', close: '' },
      { id: 2, kind: 'b', visible: true, placement: 'run', open: '', close: '' },
    ];
    const source: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'a ' },
      { t: 'close', id: 1 },
      { t: 'open', id: 2, fmt: 2 },
      { t: 'text', v: 'b' },
      { t: 'close', id: 2 },
    ];
    const tm: TmToken[] = [
      { t: 'open', id: 1, k: 'other' },
      { t: 'text', v: 'x ' },
      { t: 'close', id: 1 },
      { t: 'open', id: 2, k: 'b' },
      { t: 'text', v: 'y' },
      { t: 'close', id: 2 },
    ];
    expect(remapTmTokens(tm, source, formats)).toEqual({
      ok: true,
      tokens: [
        { t: 'text', v: 'x ' },
        { t: 'open', id: 2, fmt: 2 },
        { t: 'text', v: 'y' },
        { t: 'close', id: 2 },
      ],
    });
  });
});
