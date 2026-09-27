import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateTagStructure } from '../model/tags.js';
import type { FormatEntry, Token } from '../model/token.js';
import { documentSegments, exportDocx, importDocx } from './document.js';
import {
  escapeXmlText,
  mergeTokens,
  RenderError,
  renderRegion,
  renderTokens,
  withText,
} from './render.js';
import { nestingErrors, runOfEachChar } from './nesting.fixture.js';
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

  it('refuses text XML cannot carry rather than write a part Word rejects', () => {
    expect(() => renderTokens([{ t: 'text', v: 'soft\u000Bbreak' }], [])).toThrow(
      /U\+000B/,
    );
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

describe('renderTokens — nesting an edited target may contain (backlog #29)', () => {
  const fonts: FormatEntry = {
    id: 1,
    kind: 'other',
    visible: false,
    placement: 'run',
    open: '<w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr>',
    close: '</w:r>',
  };
  const bold: FormatEntry = {
    id: 2,
    kind: 'b',
    visible: true,
    placement: 'run',
    open: '<w:r><w:rPr><w:b/></w:rPr>',
    close: '</w:r>',
  };
  const link: FormatEntry = {
    id: 3,
    kind: 'link',
    visible: true,
    placement: 'inline',
    open: '<w:hyperlink r:id="rId9">',
    close: '</w:hyperlink>',
  };
  const proofErr: FormatEntry = {
    id: 4,
    kind: 'other',
    visible: false,
    placement: 'block',
    open: '<w:proofErr w:type="spellStart"/>',
    close: '',
  };
  const br: FormatEntry = {
    id: 5,
    kind: 'br',
    visible: true,
    placement: 'in-run',
    open: '<w:br/>',
    close: '',
  };
  const formats = [fonts, bold, link, proofErr, br];
  const text = (v: string): Token => ({ t: 'text', v });
  const open = (id: number): Token => ({ t: 'open', id, fmt: id });
  const close = (id: number): Token => ({ t: 'close', id });
  const ph = (id: number): Token => ({ t: 'ph', id, fmt: id });

  it('renders a run tag inside a run tag as sibling runs, the inner one winning', () => {
    const tokens = [
      open(1),
      text('Hola '),
      open(2),
      text('mundo'),
      close(2),
      text('!'),
      close(1),
    ];
    expect(renderTokens(tokens, formats)).toBe(
      `${fonts.open}<w:t xml:space="preserve">Hola </w:t></w:r>` +
        `${bold.open}<w:t>mundo</w:t></w:r>` +
        `${fonts.open}<w:t>!</w:t></w:r>`,
    );
  });

  it('closes the run before a paragraph-level placeholder and reopens it after', () => {
    const tokens = [open(1), text('a'), ph(4), text('b'), close(1)];
    expect(renderTokens(tokens, formats)).toBe(
      `${fonts.open}<w:t>a</w:t></w:r>${proofErr.open}${fonts.open}<w:t>b</w:t></w:r>`,
    );
  });

  it('closes the run before a hyperlink, whose text its properties do not reach', () => {
    // Run properties never cross a hyperlink in OOXML; a link's text has
    // the runs inside it, or none.
    const tokens = [open(1), text('a'), open(3), text('b'), close(3), close(1)];
    expect(renderTokens(tokens, formats)).toBe(
      `${fonts.open}<w:t>a</w:t></w:r>` +
        `${link.open}<w:r><w:t>b</w:t></w:r>${link.close}`,
    );
  });

  it('refuses a tag in a role its format does not fit', () => {
    // A run tag as a placeholder would be a <w:r> with no </w:r>.
    expect(() => renderTokens([ph(1)], formats)).toThrow(/run tag/);
    expect(() => renderTokens([open(5), close(5)], formats)).toThrow(/in-run tag/);
  });

  it('keeps a run-level placeholder inside the enclosing run', () => {
    const tokens = [open(1), text('a'), ph(5), text('b'), close(1)];
    expect(renderTokens(tokens, formats)).toBe(
      `${fonts.open}<w:t>a</w:t><w:br/><w:t>b</w:t></w:r>`,
    );
  });

  it('renders nothing for a run tag with no content', () => {
    expect(renderTokens([text('x'), open(1), close(1)], formats)).toBe(
      '<w:r><w:t>x</w:t></w:r>',
    );
  });

  it('keeps one run open across identical properties instead of splitting it', () => {
    const twin: FormatEntry = { ...fonts, id: 6 };
    const tokens = [
      open(1),
      text('a'),
      open(2),
      close(2),
      close(1),
      open(6),
      text('b'),
      close(6),
    ];
    expect(renderTokens(tokens, [...formats, twin])).toBe(
      `${fonts.open}<w:t>ab</w:t></w:r>`,
    );
  });

  it('renders every structurally valid stream to OOXML Word accepts', () => {
    // Generated streams: arbitrary nesting of runs, wrappers, hyperlinks
    // and placeholders — shapes a translator can build and a source never
    // has. Seeded, so a failure reproduces.
    for (let seed = 1; seed <= 400; seed++) {
      const { tokens, formats: table } = randomStream(seed);
      expect(validateTagStructure(tokens), `seed ${seed}`).toEqual({ ok: true });
      const out = renderTokens(tokens, table);
      expect(nestingErrors(out), `seed ${seed}: ${out}`).toEqual([]);
      const back = tokenizeRegion(out);
      expect(tokensText(back.tokens), `seed ${seed}`).toBe(tokensText(tokens));
      // Every character keeps the properties of its innermost run tag.
      expect(runOfEachChar(back.tokens, back.formats), `seed ${seed}`).toEqual(
        runOfEachChar(tokens, table),
      );
      // And the result is a fixed point, like a source render.
      expect(renderRegion(back), `seed ${seed}`).toBe(out);
    }
  });
});

const TEMPLATES: ReadonlyArray<Omit<FormatEntry, 'id'>> = [
  {
    kind: 'other',
    visible: false,
    placement: 'run',
    open: '<w:r><w:rPr><w:sz w:val="20"/></w:rPr>',
    close: '</w:r>',
  },
  {
    kind: 'b',
    visible: true,
    placement: 'run',
    open: '<w:r><w:rPr><w:b/></w:rPr>',
    close: '</w:r>',
  },
  {
    kind: 'i',
    visible: true,
    placement: 'run',
    open: '<w:r><w:rPr><w:i/></w:rPr>',
    close: '</w:r>',
  },
  {
    kind: 'link',
    visible: true,
    placement: 'inline',
    open: '<w:hyperlink w:anchor="x">',
    close: '</w:hyperlink>',
  },
  {
    kind: 'other',
    visible: false,
    placement: 'inline',
    open: '<w:ins w:id="1" w:author="R">',
    close: '</w:ins>',
  },
  {
    kind: 'other',
    visible: false,
    placement: 'inline',
    open: '<w:sdt><w:sdtPr/><w:sdtContent>',
    close: '</w:sdtContent></w:sdt>',
  },
];
const PLACEHOLDERS: ReadonlyArray<Omit<FormatEntry, 'id'>> = [
  {
    kind: 'other',
    visible: false,
    placement: 'block',
    open: '<w:proofErr w:type="gramEnd"/>',
    close: '',
  },
  {
    kind: 'bookmark',
    visible: false,
    placement: 'block',
    open: '<w:bookmarkEnd w:id="3"/>',
    close: '',
  },
  { kind: 'br', visible: true, placement: 'in-run', open: '<w:br/>', close: '' },
  {
    kind: 'other',
    visible: false,
    placement: 'in-run',
    open: '<w:lastRenderedPageBreak/>',
    close: '',
  },
];

/** A seeded, structurally valid stream of arbitrary nesting. */
function randomStream(seed: number): { tokens: Token[]; formats: FormatEntry[] } {
  let state = seed;
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const tokens: Token[] = [];
  const formats: FormatEntry[] = [];
  const add = (template: Omit<FormatEntry, 'id'>) => {
    const id = formats.length + 1;
    formats.push({ ...template, id });
    return id;
  };
  const words = ['uno', 'dos ', ' tres', 'cuatro', '', ' '];
  const fill = (depth: number) => {
    const n = 1 + Math.floor(next() * 4);
    for (let i = 0; i < n; i++) {
      const roll = next();
      if (roll < 0.4 || depth > 3) tokens.push({ t: 'text', v: pick(words) });
      else if (roll < 0.6) {
        const id = add(pick(PLACEHOLDERS));
        tokens.push({ t: 'ph', id, fmt: id });
      } else {
        const id = add(pick(TEMPLATES));
        tokens.push({ t: 'open', id, fmt: id });
        if (next() < 0.9) fill(depth + 1);
        tokens.push({ t: 'close', id });
      }
    }
  };
  fill(0);
  return { tokens, formats };
}

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
