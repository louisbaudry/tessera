import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getPart } from '../docx/package.js';
import { DRAWINGML_DIALECT, isUntranslatableFor } from '../docx/skeleton.js';
import { plainText } from '../model/token.js';
import {
  orderedPptxParts,
  importPptx,
  isPptxTranslatablePart,
  pptxSegments,
} from './document.js';
import { hasMeaningfulRunProps, tokenizePptxRegion } from './tokenize.js';
import { readPptx } from '../docx/package.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/pptx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const run = (text: string, props = 'lang="en-US" dirty="0"', inner = '') =>
  `<a:r><a:rPr ${props}>${inner}</a:rPr><a:t>${text}</a:t></a:r>`;

describe('hasMeaningfulRunProps', () => {
  it('counts formatting a translator recognises, and not the rest', () => {
    for (const on of [
      'b="1"',
      'i="1"',
      'u="sng"',
      'strike="sngStrike"',
      'baseline="30000"',
      'cap="all"',
    ]) {
      expect(hasMeaningfulRunProps(`<a:rPr lang="en-US" ${on}/>`), on).toBe(true);
    }
    for (const off of [
      'b="0"',
      'i="0"',
      'u="none"',
      'strike="noStrike"',
      'baseline="0"',
      'cap="none"',
      'sz="2400"',
      'spc="-1"',
      'dirty="0"',
      'err="1"',
    ]) {
      expect(hasMeaningfulRunProps(`<a:rPr lang="en-US" ${off}/>`), off).toBe(false);
    }
    expect(hasMeaningfulRunProps('<a:rPr><a:hlinkClick r:id="rId2"/></a:rPr>')).toBe(
      true,
    );
    expect(
      hasMeaningfulRunProps(
        '<a:rPr><a:highlight><a:srgbClr val="FFFF00"/></a:highlight></a:rPr>',
      ),
    ).toBe(true);
    // Colour is on nearly every run of a deck.
    expect(
      hasMeaningfulRunProps(
        '<a:rPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>',
      ),
    ).toBe(false);
  });
});

describe('tokenizePptxRegion', () => {
  it('turns a run into a paired tag, visible only when it is formatting', () => {
    const { tokens, formats } = tokenizePptxRegion(
      run('Hello, ') + run('world', 'lang="en-US" b="1"') + run('!'),
    );
    expect(plainText(tokens)).toBe('Hello, world!');
    expect(formats.map((f) => [f.kind, f.visible, f.placement])).toEqual([
      ['other', false, 'run'],
      ['b', true, 'run'],
      ['other', false, 'run'],
    ]);
    expect(formats[1]!.open).toBe('<a:r><a:rPr lang="en-US" b="1"></a:rPr>');
    expect(formats[1]!.close).toBe('</a:r>');
  });

  it('names a hyperlink run, a superscript and a subscript', () => {
    const { formats } = tokenizePptxRegion(
      run('link', 'lang="en-US"', '<a:hlinkClick r:id="rId2"/>') +
        run('2', 'baseline="30000"') +
        run('2', 'baseline="-25000"'),
    );
    expect(formats.map((f) => f.kind)).toEqual(['link', 'sup', 'sub']);
  });

  it('keeps a break and a field as visible placeholders, and the end properties hidden', () => {
    const { tokens, formats } = tokenizePptxRegion(
      run('a') +
        '<a:br><a:rPr lang="en-US"/></a:br>' +
        '<a:fld id="{X}" type="slidenum"><a:rPr lang="en-US"/><a:t>7</a:t></a:fld>' +
        '<a:endParaRPr lang="en-US" dirty="0"/>',
    );
    expect(tokens.filter((t) => t.t === 'ph')).toHaveLength(3);
    const ph = formats.filter((f) => f.placement === 'block');
    expect(ph.map((f) => [f.kind, f.visible])).toEqual([
      ['br', true],
      ['field', true],
      ['other', false],
    ]);
    // The field's own text is not the translator's.
    expect(plainText(tokens)).toBe('a');
  });

  it('keeps an empty run whole and hidden instead of losing it', () => {
    const empty = '<a:r><a:rPr lang="en-US"/><a:t></a:t></a:r>';
    const { tokens, formats } = tokenizePptxRegion(run('x') + empty + run('y'));
    expect(plainText(tokens)).toBe('xy');
    expect(formats.some((f) => f.open === empty && !f.visible)).toBe(true);
  });

  it('decodes entities in text', () => {
    const { tokens } = tokenizePptxRegion(run('Fish &amp; chips &lt;daily&gt;'));
    expect(plainText(tokens)).toBe('Fish & chips <daily>');
  });
});

describe('a deck', () => {
  it('reads slides in the order the deck plays them, and notes after them', () => {
    const pkg = readPptx(load('edge-cases.en.pptx'));
    expect(orderedPptxParts(pkg)).toEqual([
      'ppt/slides/slide2.xml', // plays first
      'ppt/slides/slide1.xml',
      'ppt/slides/slide3.xml',
      'ppt/notesSlides/notesSlide1.xml', // notes in the same order
      'ppt/notesSlides/notesSlide3.xml',
    ]);
    const first = pptxSegments(importPptx(load('edge-cases.en.pptx')))[0]!;
    expect(first.part).toBe('ppt/slides/slide2.xml');
    expect(first.text).toBe('Opening slide');
  });

  it('knows which parts are text: slides and notes, not masters, layouts, charts', () => {
    for (const yes of [
      'ppt/slides/slide1.xml',
      'ppt/slides/slide12.xml',
      'ppt/notesSlides/notesSlide2.xml',
    ]) {
      expect(isPptxTranslatablePart(yes), yes).toBe(true);
    }
    for (const no of [
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/notesMasters/notesMaster1.xml',
      'ppt/charts/chart1.xml',
      'ppt/slides/_rels/slide1.xml.rels',
      'ppt/slides/slide1.xml.rels',
      'ppt/presentation.xml',
    ]) {
      expect(isPptxTranslatablePart(no), no).toBe(false);
    }
  });

  it('falls back to file numbers when the play order cannot be read', () => {
    const pkg = readPptx(load('edge-cases.en.pptx'));
    const broken = {
      parts: pkg.parts.map((p) =>
        p.name === 'ppt/presentation.xml'
          ? { name: p.name, data: new TextEncoder().encode('<p:presentation/>') }
          : p,
      ),
    };
    expect(orderedPptxParts(broken).slice(0, 3)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
    ]);
  });

  it('locks what is only digits or only a field, and keeps a sentence around a field', () => {
    const segments = pptxSegments(importPptx(load('edge-cases.en.pptx')));
    const byText = new Map(segments.map((s) => [s.text, s]));
    expect(byText.get('2026')!.untranslatable).toBe(true);
    // The paragraph that is only a slide number field has no text of its own.
    expect(segments.filter((s) => s.text === '' && s.untranslatable)).toHaveLength(1);
    expect(byText.get('Slide  of the deck.')!.untranslatable).toBe(false);
    // LibreOffice writes `<number>` into a field, which has letters and is not a sentence.
    const lo = pptxSegments(importPptx(load('lo-deck.en.pptx')));
    expect(lo.some((s) => s.text.includes('number'))).toBe(false);
  });

  it('reads a field alone as untranslatable even when its text has letters', () => {
    const region = {
      key: 's1',
      ord: 0,
      children: [],
      xml: '<a:fld id="{X}" type="slidenum"><a:rPr/><a:t>&lt;number&gt;</a:t></a:fld>',
    };
    expect(isUntranslatableFor(region, DRAWINGML_DIALECT)).toBe(true);
  });

  it('leaves the relationships alone, so a hyperlink still points at its target', () => {
    const exported = importPptx(load('edge-cases.en.pptx'));
    expect(getPart(exported.pkg, 'ppt/slides/_rels/slide1.xml.rels')).toBeDefined();
  });
});
