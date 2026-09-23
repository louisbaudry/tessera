import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateTagStructure } from '../model/tags.js';
import { importDocx, translatableSegments } from './document.js';
import { decodeXmlText, tokenizeRegion, tokensText, visibleTags } from './tokenize.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.docx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

describe('tokenizeRegion — text', () => {
  it('emits plain text with no tags', () => {
    const r = tokenizeRegion('<w:r><w:t>Hello world</w:t></w:r>');
    expect(r.tokens).toEqual([{ t: 'text', v: 'Hello world' }]);
    expect(r.formats).toHaveLength(0);
  });

  it('joins text across the runs Word split it into', () => {
    // Word fragments a sentence across runs for revision tracking and
    // spell-check. The translator must see one sentence.
    const r = tokenizeRegion(
      '<w:r><w:t>Se trata </w:t></w:r><w:r><w:t>de un grupo</w:t></w:r>',
    );
    expect(tokensText(r.tokens)).toBe('Se trata de un grupo');
  });

  it('decodes XML entities', () => {
    const r = tokenizeRegion('<w:r><w:t>a &amp; b &lt;c&gt; &quot;d&quot;</w:t></w:r>');
    expect(tokensText(r.tokens)).toBe('a & b <c> "d"');
  });

  it('decodes numeric character references', () => {
    expect(decodeXmlText('&#191;Qu&#xE9;?')).toBe('¿Qué?');
  });

  it('preserves significant whitespace', () => {
    const r = tokenizeRegion('<w:r><w:t xml:space="preserve"> gap </w:t></w:r>');
    expect(tokensText(r.tokens)).toBe(' gap ');
  });
});

describe('tokenizeRegion — formatting becomes paired tags', () => {
  it('wraps a formatted run in a pair', () => {
    const r = tokenizeRegion('<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>');
    expect(r.tokens.map((t) => t.t)).toEqual(['open', 'text', 'close']);
    expect(r.formats[0]!.kind).toBe('b');
  });

  it('identifies common formatting kinds', () => {
    const kindOf = (rPr: string) =>
      tokenizeRegion(`<w:r><w:rPr>${rPr}</w:rPr><w:t>x</w:t></w:r>`).formats[0]!.kind;
    expect(kindOf('<w:i/>')).toBe('i');
    expect(kindOf('<w:u w:val="single"/>')).toBe('u');
    expect(kindOf('<w:strike/>')).toBe('strike');
    expect(kindOf('<w:vertAlign w:val="superscript"/>')).toBe('sup');
    expect(kindOf('<w:vertAlign w:val="subscript"/>')).toBe('sub');
    expect(kindOf('<w:rStyle w:val="Emphasis"/>')).toBe('style');
  });

  it('does not treat w:b w:val="0" as bold', () => {
    // Word writes an explicit off-switch when a style turns bold on.
    const r = tokenizeRegion(
      '<w:r><w:rPr><w:b w:val="0"/><w:i/></w:rPr><w:t>x</w:t></w:r>',
    );
    expect(r.formats[0]!.kind).toBe('i');
  });

  it('adds no tag for a run with no properties', () => {
    const r = tokenizeRegion('<w:r><w:rPr></w:rPr><w:t>x</w:t></w:r>');
    expect(r.tokens.map((t) => t.t)).toEqual(['text']);
  });

  it('wraps a hyperlink as a pair around its text', () => {
    const r = tokenizeRegion(
      '<w:hyperlink r:id="rId5"><w:r><w:t>click</w:t></w:r></w:hyperlink>',
    );
    expect(r.tokens.map((t) => t.t)).toEqual(['open', 'text', 'close']);
    expect(r.formats[0]!.kind).toBe('link');
    expect(r.formats[0]!.open).toContain('r:id="rId5"');
  });

  it('nests formatting inside a hyperlink', () => {
    const r = tokenizeRegion(
      '<w:hyperlink r:id="rId5">' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>bold link</w:t></w:r>' +
        '</w:hyperlink>',
    );
    expect(r.tokens.map((t) => t.t)).toEqual(['open', 'open', 'text', 'close', 'close']);
    expect(validateTagStructure(r.tokens)).toEqual({ ok: true });
  });
});

describe('tokenizeRegion — placeholders', () => {
  it('makes a footnote reference a visible placeholder', () => {
    const r = tokenizeRegion(
      '<w:r><w:t>texto</w:t></w:r>' +
        '<w:r><w:rPr><w:rStyle w:val="FootnoteRef"/></w:rPr>' +
        '<w:footnoteReference w:id="7"/></w:r>',
    );
    const ph = r.formats.find((f) => f.kind === 'footnote')!;
    expect(ph.visible).toBe(true);
    expect(ph.open).toContain('w:id="7"');
  });

  it('makes breaks, tabs and images visible placeholders', () => {
    for (const [xml, kind] of [
      ['<w:r><w:br/></w:r>', 'br'],
      ['<w:r><w:tab/></w:r>', 'tab'],
      ['<w:r><w:drawing><a/></w:drawing></w:r>', 'image'],
    ] as const) {
      const r = tokenizeRegion(xml);
      expect(r.formats[0]!.kind, xml).toBe(kind);
      expect(r.formats[0]!.visible, xml).toBe(true);
    }
  });

  it('hides spell-check and bookmark noise from the translator', () => {
    // These carry no meaning for a translation. Showing them would put
    // junk tags in front of the translator on every other sentence.
    const r = tokenizeRegion(
      '<w:proofErr w:type="spellStart"/>' +
        '<w:bookmarkStart w:id="0" w:name="_Toc1"/>' +
        '<w:r><w:t>palabra</w:t></w:r>' +
        '<w:bookmarkEnd w:id="0"/>',
    );
    expect(tokensText(r.tokens)).toBe('palabra');
    expect(r.formats.every((f) => !f.visible)).toBe(true);
    expect(visibleTags(r)).toHaveLength(0);
  });

  it('keeps hidden placeholders in the token stream', () => {
    // Hidden means "not shown", not "discarded" — they still have to be
    // re-emitted on export.
    const r = tokenizeRegion('<w:proofErr w:type="spellStart"/><w:r><w:t>x</w:t></w:r>');
    expect(r.tokens.filter((t) => t.t === 'ph')).toHaveLength(1);
  });
});

describe('tokenizeRegion — tracked changes', () => {
  it('treats an insertion as current text', () => {
    const r = tokenizeRegion(
      '<w:ins w:id="1" w:author="Reviewer"><w:r><w:t>added</w:t></w:r></w:ins>',
    );
    expect(tokensText(r.tokens)).toBe('added');
  });

  it('treats a deletion as opaque and not translatable', () => {
    // Deleted text is struck through — it is not part of what the
    // translator is being asked to translate (spec §3.5).
    const r = tokenizeRegion(
      '<w:del w:id="2" w:author="Reviewer">' +
        '<w:r><w:delText>removed</w:delText></w:r></w:del>' +
        '<w:r><w:t>kept</w:t></w:r>',
    );
    expect(tokensText(r.tokens)).toBe('kept');
    expect(r.formats.some((f) => !f.visible && f.open.includes('w:del'))).toBe(true);
  });
});

describe('tokenizeRegion — the whole corpus', () => {
  const allRegions = () =>
    fixtureNames.flatMap((name) =>
      translatableSegments(importDocx(load(name))).map((s) => ({
        where: `${name} :: ${s.part} :: ${s.key}`,
        xml: s.xml,
        text: s.text,
      })),
    );

  it('produces a valid tag structure for every segment', () => {
    // The invariant #4 defined, now load-bearing against real documents.
    for (const { where, xml } of allRegions()) {
      const result = validateTagStructure(tokenizeRegion(xml).tokens);
      expect(result, where).toEqual({ ok: true });
    }
  });

  it('preserves segment text exactly', () => {
    for (const { where, xml, text } of allRegions()) {
      expect(tokensText(tokenizeRegion(xml).tokens), where).toBe(text);
    }
  });

  it('numbers tag ids from 1 in source order', () => {
    for (const { where, xml } of allRegions()) {
      const { formats } = tokenizeRegion(xml);
      expect(
        formats.map((f) => f.id),
        where,
      ).toEqual(formats.map((_, i) => i + 1));
    }
  });

  it('gives every tag token a format entry', () => {
    for (const { where, xml } of allRegions()) {
      const { tokens, formats } = tokenizeRegion(xml);
      const ids = new Set(formats.map((f) => f.id));
      for (const token of tokens) {
        if (token.t !== 'text')
          expect(ids.has(token.id), `${where} id=${token.id}`).toBe(true);
      }
    }
  });

  it('keeps most segments free of visible tags', () => {
    // A tag model that fires on everything is unusable. Across the corpus
    // this currently sits at 57% of 1,211 segments completely tag-free,
    // with 1,992 visible tags against 12,501 hidden ones carried
    // automatically. Without the meaningful/incidental split a translator
    // would face 14,493 tags instead of 1,992.
    const regions = allRegions();
    const clean = regions.filter((r) => visibleTags(tokenizeRegion(r.xml)).length === 0);
    expect(clean.length / regions.length).toBeGreaterThan(0.5);
  });

  it('hides far more tags than it shows', () => {
    // The ratio is the point: incidental run properties outnumber real
    // formatting roughly six to one in real documents.
    let visible = 0;
    let hidden = 0;
    for (const { xml } of allRegions()) {
      const r = tokenizeRegion(xml);
      const v = visibleTags(r).length;
      visible += v;
      hidden += r.formats.length - v;
    }
    expect(hidden).toBeGreaterThan(visible * 3);
  });
});

describe('tokenizeRegion — the manuscript', () => {
  const manuscript = () => importDocx(load('footnotes-manuscript.docx'));

  it('finds footnote references inside body sentences', () => {
    // 55 paragraphs carry a reference mid-sentence, which is the case that
    // puts a placeholder *inside* a segment rather than at its edge.
    const body = translatableSegments(manuscript()).filter(
      (s) => s.part === 'word/document.xml',
    );
    const withNoteRefs = body.filter((s) =>
      tokenizeRegion(s.xml).formats.some((f) => f.kind === 'footnote'),
    );
    expect(withNoteRefs.length).toBeGreaterThanOrEqual(40);

    const midSentence = withNoteRefs.filter((s) => {
      const { tokens } = tokenizeRegion(s.xml);
      const phAt = tokens.findIndex((t) => t.t === 'ph');
      const lastText = tokens.map((t) => t.t).lastIndexOf('text');
      return phAt > 0 && phAt < lastText;
    });
    expect(midSentence.length).toBeGreaterThan(0);
  });

  it('reads Spanish text through the token stream', () => {
    const text = translatableSegments(manuscript())
      .map((s) => tokensText(tokenizeRegion(s.xml).tokens))
      .join('\n');
    expect(text).toMatch(/¿/);
    expect(text).toMatch(/«/);
    expect(text).not.toContain('&#');
  });
});
