import { describe, expect, it } from 'vitest';

import { validateTagStructure } from '../model/tags.js';
import { newInlineTable, readInline, renderInline } from './inline.js';
import { elementChildren, scanTree, XLIFF_NS, XliffError } from './scan.js';

/** Reads `<source>…</source>`'s content. */
function read(inner: string) {
  const xml = `<s xmlns="${XLIFF_NS}">${inner}</s>`;
  const el = scanTree(xml);
  const table = newInlineTable();
  const tokens = readInline(el, xml, table);
  return { tokens, formats: table.entries, xml, el, table };
}

describe('readInline', () => {
  it('reads text, decoding entities and keeping whitespace', () => {
    const { tokens } = read('  a &amp; b\n');
    expect(tokens).toEqual([{ t: 'text', v: '  a & b\n' }]);
  });

  it('reads a pc as a pair holding its original start and end tag', () => {
    const { tokens, formats } = read('a <pc id="1" type="link">b</pc> c');
    expect(tokens).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'b' },
      { t: 'close', id: 1 },
      { t: 'text', v: ' c' },
    ]);
    expect(formats).toEqual([
      {
        id: 1,
        kind: 'link',
        visible: true,
        placement: 'inline',
        open: '<pc id="1" type="link">',
        close: '</pc>',
      },
    ]);
  });

  it('reads ph, cp and an image as placeholders, one tag per occurrence', () => {
    const { tokens, formats } = read(
      '<ph id="1"/><cp hex="0001"/><cp hex="0001"/><ph id="2" type="image"/>',
    );
    expect(tokens.map((t) => t.t)).toEqual(['ph', 'ph', 'ph', 'ph']);
    expect(new Set(tokens.map((t) => (t.t === 'ph' ? t.id : -1))).size).toBe(4);
    expect(formats.map((f) => f.kind)).toEqual(['other', 'other', 'other', 'image']);
    expect(formats.every((f) => f.placement === 'in-run' && f.close === '')).toBe(true);
  });

  it('pairs sc/ec and sm/em in one segment, and sees a nested structure', () => {
    const { tokens, formats } = read(
      '<sc id="1"/>a<sm id="2"/>b<em startRef="2"/><ec startRef="1"/>',
    );
    expect(validateTagStructure(tokens)).toEqual({ ok: true });
    expect(tokens.filter((t) => t.t === 'open')).toHaveLength(2);
    expect(formats[0]).toMatchObject({
      open: '<sc id="1"/>',
      close: '<ec startRef="1"/>',
    });
  });

  it('degrades a code with no partner, or a pair that would cross another, to placeholders', () => {
    const alone = read('<sc id="1" isolated="yes"/>x<ec id="7" isolated="yes"/>');
    expect(alone.tokens.map((t) => t.t)).toEqual(['ph', 'text', 'ph']);

    const crossed = read(
      '<sc id="1"/>a<sc id="2"/>b<ec startRef="1"/>c<ec startRef="2"/>',
    );
    expect(validateTagStructure(crossed.tokens)).toEqual({ ok: true });
    expect(crossed.tokens.filter((t) => t.t === 'ph')).toHaveLength(2);
  });

  it('refuses an element that is not inline content, and a tag without an id', () => {
    expect(() => read('<x/>')).toThrow(XliffError);
    expect(() => read('<pc>a</pc>')).toThrow(/no id/);
    expect(() => read('<other xmlns="urn:x"/>')).toThrow(/not XLIFF inline/);
  });

  it('matches a target tag to the source tag of the same element and id', () => {
    const xml = `<u xmlns="${XLIFF_NS}"><source>a <pc id="1">b</pc></source><target><pc id="1">B</pc> a</target></u>`;
    const [source, target] = elementChildren(scanTree(xml));
    const table = newInlineTable();
    readInline(source!, xml, table);
    const t = readInline(target!, xml, table);
    expect(table.entries).toHaveLength(1);
    expect(t[0]).toEqual({ t: 'open', id: 1, fmt: 1 });
  });
});

describe('renderInline', () => {
  it('writes back what was read, with text escaped', () => {
    const inner =
      'a <pc id="1">b &amp; &lt;c&gt;</pc><ph id="2"/><sc id="3"/>x<ec startRef="3"/>';
    const { tokens, formats } = read(inner);
    expect(renderInline(tokens, formats)).toBe(inner);
  });

  it('refuses a tag the table does not hold', () => {
    expect(() => renderInline([{ t: 'ph', id: 4, fmt: 4 }], [])).toThrow(XliffError);
  });
});
