import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getPart, readDocx, translatableParts } from './package.js';
import {
  extractSkeleton,
  isUntranslatable,
  regionText,
  renderSkeleton,
  SkeletonError,
} from './skeleton.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.docx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Every translatable part of a fixture, as XML strings. */
function partsOf(name: string): Array<{ part: string; xml: string }> {
  const pkg = readDocx(load(name));
  return translatableParts(pkg).map((part) => ({
    part,
    xml: decode(getPart(pkg, part)!),
  }));
}

describe('extractSkeleton / renderSkeleton', () => {
  // The property #8 depends on. If this holds for every part of every real
  // document, the skeleton approach is sound; if it does not, the whole
  // design needs rethinking.
  it.each(fixtureNames)('%s: unmodified render is byte-identical', (name) => {
    for (const { part, xml } of partsOf(name)) {
      const sk = extractSkeleton(part, xml);
      expect(renderSkeleton(sk), `${name} :: ${part}`).toBe(xml);
    }
  });

  it('extracts a region per paragraph', () => {
    const xml =
      '<w:body><w:p><w:r><w:t>one</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>two</w:t></w:r></w:p></w:body>';
    const sk = extractSkeleton('t.xml', xml);
    expect(sk.regions).toHaveLength(2);
    expect(sk.regions.map((r) => r.ord)).toEqual([0, 1]);
    expect(regionText(sk.regions[0]!)).toBe('one');
    expect(regionText(sk.regions[1]!)).toBe('two');
  });

  it('keeps paragraph properties in the skeleton, not the region', () => {
    // w:pPr is formatting, not content. It must survive even for a
    // paragraph whose text is replaced wholesale.
    const xml =
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
      '<w:r><w:t>Title</w:t></w:r></w:p>';
    const sk = extractSkeleton('t.xml', xml);
    expect(sk.skeleton).toContain('<w:pStyle w:val="Heading1"/>');
    expect(sk.regions[0]!.xml).not.toContain('w:pStyle');
    expect(sk.regions[0]!.xml).toBe('<w:r><w:t>Title</w:t></w:r>');
  });

  it('applies a replacement while leaving everything else intact', () => {
    const xml =
      '<w:body><w:p><w:r><w:t>keep</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>change</w:t></w:r></w:p></w:body>';
    const sk = extractSkeleton('t.xml', xml);
    const out = renderSkeleton(
      sk,
      new Map([[sk.regions[1]!.key, '<w:r><w:t>cambiado</w:t></w:r>']]),
    );
    expect(out).toContain('<w:t>keep</w:t>');
    expect(out).toContain('<w:t>cambiado</w:t>');
    expect(out).not.toContain('<w:t>change</w:t>');
  });

  it('throws on an unknown marker rather than emitting it', () => {
    const sk = extractSkeleton('t.xml', '<w:p><w:r><w:t>x</w:t></w:r></w:p>');
    const broken = { ...sk, skeleton: sk.skeleton + '<!--cat:s99-->' };
    expect(() => renderSkeleton(broken)).toThrow(SkeletonError);
  });

  it('handles a part with no paragraphs', () => {
    const xml = '<w:styles><w:style w:styleId="a"/></w:styles>';
    const sk = extractSkeleton('word/styles.xml', xml);
    expect(sk.regions).toHaveLength(0);
    expect(renderSkeleton(sk)).toBe(xml);
  });
});

describe('nested paragraphs', () => {
  // Text boxes contain their own paragraphs, so regions nest. The outer
  // region must carry a marker for the inner one, not the inner XML.
  const NESTED =
    '<w:p><w:r><w:t>before</w:t></w:r>' +
    '<w:r><mc:AlternateContent><w:txbxContent>' +
    '<w:p><w:r><w:t>inside box</w:t></w:r></w:p>' +
    '</w:txbxContent></mc:AlternateContent></w:r>' +
    '<w:r><w:t>after</w:t></w:r></w:p>';

  it('gives the nested paragraph its own region', () => {
    const sk = extractSkeleton('t.xml', NESTED);
    expect(sk.regions).toHaveLength(2);
    const outer = sk.regions.find((r) => r.children.length > 0)!;
    const inner = sk.regions.find((r) => r.children.length === 0)!;
    expect(regionText(inner)).toBe('inside box');
    expect(outer.xml).toContain(`<!--cat:${inner.key}-->`);
    expect(outer.xml).not.toContain('inside box');
  });

  it('round-trips nested regions', () => {
    const sk = extractSkeleton('t.xml', NESTED);
    expect(renderSkeleton(sk)).toBe(NESTED);
  });

  it('can replace only the inner paragraph', () => {
    const sk = extractSkeleton('t.xml', NESTED);
    const inner = sk.regions.find((r) => r.children.length === 0)!;
    const out = renderSkeleton(
      sk,
      new Map([[inner.key, '<w:r><w:t>dentro</w:t></w:r>']]),
    );
    expect(out).toContain('dentro');
    expect(out).toContain('<w:t>before</w:t>');
    expect(out).toContain('<w:t>after</w:t>');
  });

  it('finds text boxes in the real fixture', () => {
    // rich-mixed-content carries 20 text boxes.
    const { xml } = partsOf('rich-mixed-content.docx').find(
      (p) => p.part === 'word/document.xml',
    )!;
    const sk = extractSkeleton('word/document.xml', xml);
    expect(sk.regions.some((r) => r.children.length > 0)).toBe(true);
  });
});

describe('real-document structure', () => {
  it('extracts footnote bodies as regions', () => {
    // 72 notes. Footnote bodies are translatable (spec §3.5), which is why
    // footnotes.xml gets its own skeleton.
    const { xml } = partsOf('footnotes-manuscript.docx').find(
      (p) => p.part === 'word/footnotes.xml',
    )!;
    const sk = extractSkeleton('word/footnotes.xml', xml);
    const withText = sk.regions.filter((r) => regionText(r).trim().length > 0);
    expect(withText.length).toBeGreaterThanOrEqual(70);
  });

  it('gives each of the ten footers its own skeleton', () => {
    const footers = partsOf('footnotes-manuscript.docx').filter((p) =>
      /footer\d+\.xml$/.test(p.part),
    );
    expect(footers).toHaveLength(10);
    for (const { part, xml } of footers) {
      expect(renderSkeleton(extractSkeleton(part, xml))).toBe(xml);
    }
  });

  it('extracts table cell paragraphs', () => {
    const { xml } = partsOf('table-hyperlink.docx').find(
      (p) => p.part === 'word/document.xml',
    )!;
    expect(xml).toContain('<w:tbl>');
    const sk = extractSkeleton('word/document.xml', xml);
    expect(sk.regions.length).toBeGreaterThan(0);
    expect(renderSkeleton(sk)).toBe(xml);
  });

  it('preserves tracked-change markup inside regions', () => {
    const { xml } = partsOf('tracked-changes-endnotes.docx').find(
      (p) => p.part === 'word/document.xml',
    )!;
    const sk = extractSkeleton('word/document.xml', xml);
    const joined = sk.regions.map((r) => r.xml).join('');
    expect(joined).toContain('<w:del ');
    expect(renderSkeleton(sk)).toBe(xml);
  });

  it('reads Spanish text through XML entities correctly', () => {
    const { xml } = partsOf('footnotes-manuscript.docx').find(
      (p) => p.part === 'word/document.xml',
    )!;
    const sk = extractSkeleton('word/document.xml', xml);
    const all = sk.regions.map(regionText).join('\n');
    expect(all).toMatch(/[¿¡]/);
    expect(all).not.toContain('&amp;');
  });
});

describe('isUntranslatable', () => {
  const region = (xml: string) => extractSkeleton('t.xml', xml).regions[0]!;

  it('flags a paragraph with no letters', () => {
    expect(isUntranslatable(region('<w:p><w:r><w:t>123 — 45</w:t></w:r></w:p>'))).toBe(
      true,
    );
  });

  it('flags an empty paragraph', () => {
    expect(isUntranslatable(region('<w:p></w:p>'))).toBe(true);
  });

  it('does not flag Spanish text with accents and inverted marks', () => {
    expect(isUntranslatable(region('<w:p><w:r><w:t>¿Está aquí?</w:t></w:r></w:p>'))).toBe(
      false,
    );
  });

  it('does not flag a letter buried among numbers', () => {
    expect(isUntranslatable(region('<w:p><w:r><w:t>1. a</w:t></w:r></w:p>'))).toBe(false);
  });
});
