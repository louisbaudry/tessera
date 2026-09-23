import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateTagStructure } from '../model/tags.js';
import type { Token } from '../model/token.js';
import { documentSegments, exportDocx, importDocx } from './document.js';
import {
  escapeXmlText,
  mergeTokens,
  RenderError,
  renderRegion,
  renderTokens,
  withText,
} from './render.js';
import { tokenizeRegion, tokensText, visibleTags } from './tokenize.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.docx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

describe('renderTokens — basics', () => {
  it('wraps bare text in a run', () => {
    const r = tokenizeRegion('<w:r><w:t>hola</w:t></w:r>');
    expect(renderRegion(r)).toBe('<w:r><w:t>hola</w:t></w:r>');
  });

  it('escapes XML metacharacters', () => {
    expect(escapeXmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    const r = tokenizeRegion('<w:r><w:t>a &amp; b</w:t></w:r>');
    expect(renderRegion(r)).toContain('a &amp; b');
  });

  it('preserves edge whitespace explicitly', () => {
    // Without xml:space Word collapses the space and joins the words
    // across the formatting boundary.
    const r = tokenizeRegion('<w:r><w:t xml:space="preserve">bold </w:t></w:r>');
    expect(renderRegion(r)).toContain('xml:space="preserve"');
  });

  it('omits xml:space when the text has no edge whitespace', () => {
    const r = tokenizeRegion('<w:r><w:t>palabra</w:t></w:r>');
    expect(renderRegion(r)).not.toContain('xml:space');
  });

  it('reproduces a formatted run', () => {
    const xml = '<w:r><w:rPr><w:i/></w:rPr><w:t>cursiva</w:t></w:r>';
    expect(renderRegion(tokenizeRegion(xml))).toBe(xml);
  });

  it('reproduces a hyperlink with nested formatting', () => {
    const xml =
      '<w:hyperlink r:id="rId5">' +
      '<w:r><w:rPr><w:b/></w:rPr><w:t>enlace</w:t></w:r>' +
      '</w:hyperlink>';
    expect(renderRegion(tokenizeRegion(xml))).toBe(xml);
  });
});

describe('renderTokens — placeholders', () => {
  it('keeps a run-level placeholder inside a run', () => {
    const r = tokenizeRegion('<w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r>');
    const out = renderRegion(r);
    expect(out).toContain('<w:br/>');
    expect(validateTagStructure(tokenizeRegion(out).tokens)).toEqual({ ok: true });
  });

  it('wraps a bare placeholder in a run when it stands alone', () => {
    const { formats } = tokenizeRegion('<w:r><w:br/></w:r>');
    const tokens: Token[] = [{ t: 'ph', id: 1, fmt: 1 }];
    expect(renderTokens(tokens, formats)).toBe('<w:r><w:br/></w:r>');
  });

  it('reproduces a footnote reference byte for byte', () => {
    // Getting this wrong detaches the note from its anchor.
    const xml =
      '<w:r><w:rPr><w:rStyle w:val="FootnoteRef"/></w:rPr>' +
      '<w:footnoteReference w:id="7"/></w:r>';
    expect(renderRegion(tokenizeRegion(xml))).toContain(
      '<w:footnoteReference w:id="7"/>',
    );
  });

  it('keeps a block-level placeholder out of a run', () => {
    const r = tokenizeRegion(
      '<w:bookmarkStart w:id="0" w:name="x"/><w:r><w:t>t</w:t></w:r>',
    );
    const out = renderRegion(r);
    expect(out.startsWith('<w:bookmarkStart')).toBe(true);
  });
});

describe('renderTokens — rejects invalid targets', () => {
  const formats = tokenizeRegion('<w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r>').formats;

  it('refuses an unclosed tag', () => {
    expect(() => renderTokens([{ t: 'open', id: 1, fmt: 1 }], formats)).toThrow(
      RenderError,
    );
  });

  it('refuses a close with no open', () => {
    expect(() => renderTokens([{ t: 'close', id: 1 }], formats)).toThrow(/unclosed|open/);
  });

  it('refuses interleaved pairs', () => {
    const two = tokenizeRegion(
      '<w:r><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>' +
        '<w:r><w:rPr><w:i/></w:rPr><w:t>b</w:t></w:r>',
    ).formats;
    const bad: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      { t: 'open', id: 2, fmt: 2 },
      { t: 'close', id: 1 },
      { t: 'close', id: 2 },
    ];
    expect(() => renderTokens(bad, two)).toThrow(RenderError);
  });

  it('refuses a token pointing at a format that does not exist', () => {
    expect(() => renderTokens([{ t: 'ph', id: 99, fmt: 99 }], formats)).toThrow(
      /unknown format id/,
    );
  });
});

describe('mergeTokens — re-merging', () => {
  it('joins adjacent text', () => {
    const merged = mergeTokens(
      [
        { t: 'text', v: 'una ' },
        { t: 'text', v: 'frase' },
      ],
      [],
    );
    expect(merged).toEqual([{ t: 'text', v: 'una frase' }]);
  });

  it('re-merges neighbouring runs with identical properties', () => {
    // Word fragments a sentence across runs; after editing there is no
    // reason to keep the split, and keeping it compounds on every save.
    const xml =
      '<w:r><w:rPr><w:i/></w:rPr><w:t>Se trata </w:t></w:r>' +
      '<w:r><w:rPr><w:i/></w:rPr><w:t>de un grupo</w:t></w:r>';
    const r = tokenizeRegion(xml);
    expect(r.tokens.filter((t) => t.t === 'open')).toHaveLength(2);
    const out = renderRegion(r);
    expect(out).toBe('<w:r><w:rPr><w:i/></w:rPr><w:t>Se trata de un grupo</w:t></w:r>');
  });

  it('does not merge runs with different properties', () => {
    const xml =
      '<w:r><w:rPr><w:i/></w:rPr><w:t>a</w:t></w:r>' +
      '<w:r><w:rPr><w:b/></w:rPr><w:t>b</w:t></w:r>';
    expect(renderRegion(tokenizeRegion(xml))).toBe(xml);
  });
});

describe('renderTokens — wrappers survive translation', () => {
  it('keeps a tracked insertion marked as an insertion', () => {
    // Flattening w:ins would silently accept a reviewer's pending
    // insertion — a change to the document's revision state that a
    // translation tool has no business making.
    const xml =
      '<w:ins w:id="1" w:author="Reviewer" w:date="2020-01-01T00:00:00Z">' +
      '<w:r><w:t>añadido</w:t></w:r></w:ins>';
    const r = tokenizeRegion(xml);
    const out = renderTokens(withText(r, 'added'), r.formats);
    expect(out).toContain('<w:ins ');
    expect(out).toContain('w:author="Reviewer"');
    expect(out).toContain('</w:ins>');
    expect(out).toContain('added');
  });

  it('keeps a content control around its translated body', () => {
    const xml =
      '<w:sdt><w:sdtPr><w:alias w:val="Title"/></w:sdtPr>' +
      '<w:sdtContent><w:r><w:t>Título</w:t></w:r></w:sdtContent></w:sdt>';
    const r = tokenizeRegion(xml);
    const out = renderTokens(withText(r, 'Title'), r.formats);
    expect(out).toContain('<w:sdtPr><w:alias w:val="Title"/></w:sdtPr>');
    expect(out).toContain('<w:sdtContent>');
    expect(out).toContain('</w:sdtContent></w:sdt>');
    expect(tokensText(tokenizeRegion(out).tokens)).toBe('Title');
  });

  it('keeps a deletion whole and unmodified', () => {
    const xml =
      '<w:del w:id="2" w:author="Reviewer">' +
      '<w:r><w:delText>borrado</w:delText></w:r></w:del>' +
      '<w:r><w:t>kept</w:t></w:r>';
    const out = renderRegion(tokenizeRegion(xml));
    expect(out).toContain('<w:delText>borrado</w:delText>');
  });
});

describe('withText — carrying tags onto a target', () => {
  it('keeps a wrapping pair around the new text', () => {
    const r = tokenizeRegion('<w:r><w:rPr><w:b/></w:rPr><w:t>Save</w:t></w:r>');
    const out = renderTokens(withText(r, 'Guardar'), r.formats);
    expect(out).toBe('<w:r><w:rPr><w:b/></w:rPr><w:t>Guardar</w:t></w:r>');
  });

  it('produces a valid structure for a plain segment', () => {
    const r = tokenizeRegion('<w:r><w:t>Hello</w:t></w:r>');
    const tokens = withText(r, 'Hola');
    expect(validateTagStructure(tokens)).toEqual({ ok: true });
    expect(tokensText(tokens)).toBe('Hola');
  });
});

describe('renderTokens — the whole corpus', () => {
  const allSegments = () =>
    fixtureNames.flatMap((name) =>
      documentSegments(importDocx(load(name)))
        .filter((s) => !s.untranslatable)
        .map((s) => ({ where: `${name} :: ${s.part} :: ${s.key}`, xml: s.xml })),
    );

  it('renders every segment without throwing', () => {
    for (const { where, xml } of allSegments()) {
      expect(() => renderRegion(tokenizeRegion(xml)), where).not.toThrow();
    }
  });

  it('preserves segment text through a render', () => {
    for (const { where, xml } of allSegments()) {
      const before = tokenizeRegion(xml);
      const after = tokenizeRegion(renderRegion(before));
      expect(tokensText(after.tokens), where).toBe(tokensText(before.tokens));
    }
  });

  it('is stable: rendering twice changes nothing further', () => {
    // Re-merging must reach a fixed point, or every save would keep
    // rewriting the document.
    for (const { where, xml } of allSegments()) {
      const once = renderRegion(tokenizeRegion(xml));
      const twice = renderRegion(tokenizeRegion(once));
      expect(twice, where).toBe(once);
    }
  });

  it('never loses a kind of formatting', () => {
    // Compared as a set, not a count: re-merging two adjacent bold runs
    // into one legitimately reduces the tag count (spec §3.4), but bold
    // text must still come out bold.
    for (const { where, xml } of allSegments()) {
      const before = tokenizeRegion(xml);
      const after = tokenizeRegion(renderRegion(before));
      const kindsBefore = new Set(visibleTags(before).map((f) => f.kind));
      const kindsAfter = new Set(visibleTags(after).map((f) => f.kind));
      expect([...kindsAfter].sort(), where).toEqual([...kindsBefore].sort());
    }
  });

  it('never increases the number of visible tags', () => {
    // Re-merging may reduce the count; nothing should ever add tags.
    for (const { where, xml } of allSegments()) {
      const before = tokenizeRegion(xml);
      const after = tokenizeRegion(renderRegion(before));
      expect(visibleTags(after).length, where).toBeLessThanOrEqual(
        visibleTags(before).length,
      );
    }
  });

  it('produces a valid tag structure every time', () => {
    for (const { where, xml } of allSegments()) {
      const out = tokenizeRegion(renderRegion(tokenizeRegion(xml)));
      expect(validateTagStructure(out.tokens), where).toEqual({ ok: true });
    }
  });
});

describe('end to end: a translated document', () => {
  it('exports a modified segment and reads it back', () => {
    const doc = importDocx(load('prose-short.docx'));
    const target = documentSegments(doc).find((s) => !s.untranslatable)!;
    const region = tokenizeRegion(target.xml);
    const rendered = renderTokens(withText(region, 'Texto traducido'), region.formats);

    const out = exportDocx(
      doc,
      new Map([[target.part, new Map([[target.key, rendered]])]]),
    );
    const texts = documentSegments(importDocx(out)).map((s) => s.text);
    expect(texts).toContain('Texto traducido');
  });

  it('translates every segment of a document with footnotes', () => {
    // The realistic shape of a job: body and note bodies both replaced.
    const doc = importDocx(load('footnotes-manuscript.docx'));
    const byPart = new Map<string, Map<string, string>>();
    let count = 0;
    for (const segment of documentSegments(doc)) {
      if (segment.untranslatable) continue;
      const region = tokenizeRegion(segment.xml);
      const rendered = renderTokens(
        withText(region, `«${segment.text}»`),
        region.formats,
      );
      if (!byPart.has(segment.part)) byPart.set(segment.part, new Map());
      byPart.get(segment.part)!.set(segment.key, rendered);
      count++;
    }
    expect(count).toBeGreaterThan(300);

    const out = exportDocx(doc, byPart);
    const reimported = documentSegments(importDocx(out)).filter((s) => !s.untranslatable);
    expect(reimported.length).toBe(count);
    expect(reimported.every((s) => s.text.startsWith('«'))).toBe(true);
  });
});
