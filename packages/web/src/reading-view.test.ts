import type { FormatEntry, Segment, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  partTitle,
  readingProgress,
  readingSpans,
  readingSummary,
  readingView,
} from './reading-view.js';

let nextId = 1;
const seg = (over: Partial<Segment> = {}): Segment => ({
  id: nextId++,
  fileId: 1,
  part: 'document',
  ord: 0,
  paraKey: 's1',
  paraOrd: 0,
  sourceTokens: [{ t: 'text', v: 'Hello.' }],
  formatTable: [],
  targetTokens: null,
  sourceHash: 'h',
  status: 'new',
  origin: null,
  locked: false,
  fallbackCopy: false,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const fmt = (id: number, kind: FormatEntry['kind'], visible = true): FormatEntry => ({
  id,
  kind,
  visible,
  placement: kind === 'br' || kind === 'tab' ? 'in-run' : 'run',
  open: '',
  close: '',
});
const text = (v: string): Token => ({ t: 'text', v });

describe('readingSpans', () => {
  it('draws the marks of the tags open around the text, nested ones together', () => {
    const formats = [fmt(0, 'b'), fmt(1, 'i')];
    const tokens: Token[] = [
      text('A '),
      { t: 'open', id: 1, fmt: 0 },
      text('bold '),
      { t: 'open', id: 2, fmt: 1 },
      text('both'),
      { t: 'close', id: 2 },
      { t: 'close', id: 1 },
      text(' plain'),
    ];
    expect(readingSpans(tokens, formats)).toEqual([
      { text: 'A ', marks: [] },
      { text: 'bold ', marks: ['b'] },
      { text: 'both', marks: ['b', 'i'] },
      { text: ' plain', marks: [] },
    ]);
  });

  it('turns a line break and a tab into their characters and reads other tags through', () => {
    const formats = [fmt(0, 'br'), fmt(1, 'tab'), fmt(2, 'image'), fmt(3, 'style')];
    const tokens: Token[] = [
      text('one'),
      { t: 'ph', id: 1, fmt: 0 },
      text('two'),
      { t: 'ph', id: 2, fmt: 1 },
      { t: 'ph', id: 3, fmt: 2 },
      { t: 'open', id: 4, fmt: 3 },
      text('three'),
      { t: 'close', id: 4 },
    ];
    // A style run draws no mark, so its text joins the span before it.
    expect(readingSpans(tokens, formats)).toEqual([
      { text: 'one\ntwo\tthree', marks: [] },
    ]);
  });

  it('leaves a hidden tag out, and keeps the text inside it', () => {
    const formats = [fmt(0, 'b', false)];
    const tokens: Token[] = [
      { t: 'open', id: 1, fmt: 0 },
      text('kept'),
      { t: 'close', id: 1 },
    ];
    expect(readingSpans(tokens, formats)).toEqual([{ text: 'kept', marks: [] }]);
  });

  it('survives a tag whose format points nowhere and a close with no open', () => {
    const tokens: Token[] = [
      { t: 'open', id: 1, fmt: 9 },
      text('x'),
      { t: 'close', id: 7 },
      { t: 'ph', id: 2, fmt: 9 },
    ];
    expect(readingSpans(tokens, [])).toEqual([{ text: 'x', marks: [] }]);
  });
});

describe('readingView', () => {
  it('flows each paragraph’s sentences in order, the target where there is one', () => {
    const view = readingView([
      seg({ id: 3, ord: 2, paraKey: 's2', sourceTokens: [text('Second para.')] }),
      seg({
        id: 2,
        ord: 1,
        paraKey: 's1',
        paraOrd: 1,
        sourceTokens: [text(' Two.')],
        targetTokens: [text(' Zwei.')],
      }),
      seg({ id: 1, ord: 0, paraKey: 's1', paraOrd: 0, sourceTokens: [text('One.')] }),
    ]);
    expect(view).toHaveLength(1);
    expect(view[0]!.title).toBe('Text');
    expect(view[0]!.paragraphs.map((p) => p.key)).toEqual(['document/s1', 'document/s2']);
    expect(view[0]!.paragraphs[0]!.segments).toEqual([
      { id: 1, shown: 'source', spans: [{ text: 'One.', marks: [] }] },
      { id: 2, shown: 'target', spans: [{ text: ' Zwei.', marks: [] }] },
    ]);
  });

  it('keeps parts apart in the order they first appear, and names them', () => {
    const view = readingView([
      seg({ ord: 0, part: 'header1', paraKey: 'h1' }),
      seg({ ord: 1, part: 'document', paraKey: 's1' }),
      seg({ ord: 2, part: 'footnotes', paraKey: 'f1' }),
    ]);
    expect(view.map((s) => s.title)).toEqual(['Header 1', 'Text', 'Footnotes']);
  });

  it('shows a text box’s fallback copy once', () => {
    const view = readingView([
      seg({ ord: 0, paraKey: 's1' }),
      seg({ ord: 1, paraKey: 's9', fallbackCopy: true }),
    ]);
    expect(view[0]!.paragraphs.map((p) => p.key)).toEqual(['document/s1']);
  });

  it('drops a paragraph with no text, and keeps an empty target in place as its own choice', () => {
    const view = readingView([
      seg({ ord: 0, paraKey: 's1', sourceTokens: [] }),
      seg({ ord: 1, paraKey: 's2', paraOrd: 0, sourceTokens: [text('Kept.')] }),
      seg({
        ord: 2,
        paraKey: 's2',
        paraOrd: 1,
        sourceTokens: [text(' Gone.')],
        targetTokens: [],
      }),
    ]);
    expect(view[0]!.paragraphs.map((p) => p.key)).toEqual(['document/s2']);
    expect(view[0]!.paragraphs[0]!.segments[1]).toMatchObject({
      shown: 'target',
      spans: [],
    });
  });
});

describe('readingProgress', () => {
  it('counts the sentences shown in the target and those still in the source', () => {
    const view = readingView([
      seg({ ord: 0, paraKey: 's1', targetTokens: [text('Ja.')] }),
      seg({ ord: 1, paraKey: 's1', paraOrd: 1 }),
      seg({ ord: 2, paraKey: 's2' }),
    ]);
    expect(readingProgress(view)).toEqual({ shownTarget: 1, shownSource: 2 });
  });
});

describe('partTitle', () => {
  it('names every part kind, and shows an unknown one as it is', () => {
    expect(partTitle('slide3')).toBe('Slide 3');
    expect(partTitle('notes3')).toBe('Notes 3');
    expect(partTitle('sheet2')).toBe('Sheet 2');
    expect(partTitle('footer1')).toBe('Footer 1');
    expect(partTitle('endnotes')).toBe('Endnotes');
    expect(partTitle('xliff')).toBe('Text');
    expect(partTitle('strings')).toBe('Text');
  });
});

describe('readingSummary', () => {
  it('counts in words, singular and plural, and says nothing of the source once all is done', () => {
    expect(readingSummary({ shownTarget: 1, shownSource: 16 })).toBe(
      '1 sentence in the translation, 16 sentences still in the source (grey).',
    );
    expect(readingSummary({ shownTarget: 1200, shownSource: 1 })).toBe(
      '1,200 sentences in the translation, 1 sentence still in the source (grey).',
    );
    expect(readingSummary({ shownTarget: 3, shownSource: 0 })).toBe(
      '3 sentences in the translation.',
    );
  });
});
