import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { documentSegments, importDocx } from '../docx/document.js';
import { tokenizeRegion } from '../docx/tokenize.js';
import { countRegionWords, hasSpacedWords } from '../model/words.js';
import { countDocxWords, countTextWords, MAX_COUNT_INFLATED_BYTES } from './count.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

/** A minimal DOCX whose body is `body`. */
function docx(body: string, extra: Record<string, string> = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    ),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  });
}

const para = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

describe('the written definition, through a real DOCX', () => {
  it('counts e-mail, l’homme-style words and 1,000.50 as one word each', () => {
    const bytes = docx(para(run("e-mail l'homme 1,000.50")));
    expect(countDocxWords(bytes, 'en')).toBe(3);
  });

  it('splits at a tab, joins across a bookmark, a soft hyphen and a no-break hyphen', () => {
    const cases: Array<[string, number]> = [
      [para(run('one'), '<w:r><w:tab/></w:r>', run('two')), 2],
      [para(run('mid'), '<w:bookmarkStart w:id="0" w:name="b"/>', run('word')), 1],
      [para(run('soft'), '<w:r><w:softHyphen/></w:r>', run('hyphen')), 1],
      [para(run('e'), '<w:r><w:noBreakHyphen/></w:r>', run('mail')), 1],
      [para(run('line'), '<w:r><w:br/></w:r>', run('break')), 2],
    ];
    for (const [body, n] of cases) expect(countDocxWords(docx(body), 'en')).toBe(n);
  });

  it('leaves a letterless paragraph out: it is locked, not translated', () => {
    const bytes = docx(para(run('2024 1,000.50')) + para(run('two words')));
    expect(countDocxWords(bytes, 'en')).toBe(2);
  });

  it('counts hidden (w:vanish) text: the editor shows it and it is translated', () => {
    const hidden = '<w:r><w:rPr><w:vanish/></w:rPr><w:t>secret words</w:t></w:r>';
    expect(countDocxWords(docx(para(run('shown '), hidden)), 'en')).toBe(3);
  });

  it('counts headers, footers and footnotes as well as the body', () => {
    const part = (tag: string, text: string) =>
      `<?xml version="1.0"?><w:${tag} ${NS}>${para(run(text))}</w:${tag}>`;
    const bytes = docx(para(run('body text')), {
      'word/header1.xml': part('hdr', 'head'),
      'word/footer1.xml': part('ftr', 'foot note'),
      'word/footnotes.xml': part('footnotes', 'one two three'),
    });
    expect(countDocxWords(bytes, 'en')).toBe(2 + 1 + 2 + 3);
  });
});

describe('a text box stored as Choice and Fallback counts once', () => {
  const box = (text: string) => `<w:txbxContent>${para(run(text))}</w:txbxContent>`;
  const alt =
    '<w:r><mc:AlternateContent>' +
    `<mc:Choice Requires="wps"><w:drawing>${box('boxed text here')}</w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict>${box('boxed text here')}</w:pict></mc:Fallback>` +
    '</mc:AlternateContent></w:r>';

  it('synthetic', () => {
    expect(countDocxWords(docx(para(run('before ')) + para(alt)), 'en')).toBe(1 + 3);
  });

  it('still counts a text box that has no fallback', () => {
    const lone = `<w:r><w:drawing>${box('only copy')}</w:drawing></w:r>`;
    expect(countDocxWords(docx(para(lone)), 'en')).toBe(2);
  });

  const FIVE = [
    'fields-textboxes.docx',
    'image-heavy.docx',
    'large-media-packet.docx',
    'media-heavy-packet.docx',
    'rich-mixed-content.docx',
  ];

  /** Every extractable region counted, fallback copies included. */
  function everyCopy(bytes: Uint8Array): number {
    return documentSegments(importDocx(bytes))
      .filter((s) => !s.untranslatable)
      .reduce((n, s) => n + countRegionWords(tokenizeRegion(s.xml)), 0);
  }

  it.each(FIVE)('%s: the count is below the sum over every region', (name) => {
    const bytes = load(name);
    const counted = countDocxWords(bytes, 'en')!;
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThan(everyCopy(bytes));
  });

  it('a fixture with no Fallback counts every region', () => {
    const bytes = load('prose-short.docx');
    expect(countDocxWords(bytes, 'en')).toBe(everyCopy(bytes));
  });

  it('counts every fixture without throwing', () => {
    for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith('.docx'))) {
      expect(countDocxWords(load(name), 'en'), name).toEqual(expect.any(Number));
    }
  });
});

describe('null, never a wrong number', () => {
  it('an unspaced source language', () => {
    const bytes = docx(para(run('two words')));
    for (const lang of ['zh', 'zh-CN', 'ja', 'th', 'km', 'lo', 'my', 'bo']) {
      expect(hasSpacedWords(lang)).toBe(false);
      expect(countDocxWords(bytes, lang)).toBeNull();
      expect(countTextWords('two words', lang)).toBeNull();
    }
    expect(hasSpacedWords('ko')).toBe(true);
  });

  it('bytes that are not a DOCX', () => {
    expect(countDocxWords(strToU8('plain text'), 'en')).toBeNull();
    expect(countDocxWords(new Uint8Array(0), 'en')).toBeNull();
    expect(countDocxWords(zipSync({ 'a.txt': strToU8('x') }), 'en')).toBeNull();
  });

  it('malformed XML, and a numeric entity past U+10FFFF', () => {
    expect(countDocxWords(docx('<w:p><w:r>'), 'en')).toBeNull();
    expect(countDocxWords(docx(para(run('bad &#x110000; entity'))), 'en')).toBeNull();
  });

  it('a part that is not UTF-8', () => {
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': new Uint8Array([0xff, 0xfe, 0x3c, 0x00]),
    });
    expect(countDocxWords(bytes, 'en')).toBeNull();
  });

  it('a package that would inflate past the cap, without inflating it', () => {
    const big = new Uint8Array(MAX_COUNT_INFLATED_BYTES + 1).fill(0x20);
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': big,
    });
    expect(bytes.length).toBeLessThan(1024 * 1024);
    expect(countDocxWords(bytes, 'en')).toBeNull();
  });

  it('does not inflate parts it does not read', () => {
    const small = unzipSync(docx(para(run('two words'))));
    const withMedia = zipSync({
      ...small,
      'word/media/image1.bin': new Uint8Array(MAX_COUNT_INFLATED_BYTES + 1),
    });
    expect(countDocxWords(withMedia, 'en')).toBe(2);
  });
});

describe('countTextWords', () => {
  it('counts text', () => {
    expect(countTextWords('one two\tthree\nfour', 'en')).toBe(4);
  });

  it('is null for a NUL or other C0 control, but not for tab, LF, CR, FF', () => {
    expect(countTextWords('a\u0000b c', 'en')).toBeNull();
    expect(countTextWords('a\u0001 b', 'en')).toBeNull();
    expect(countTextWords('a\tb\nc\rd\fe', 'en')).toBe(5);
  });

  it('a kept leading BOM neither counts nor joins', () => {
    expect(countTextWords('﻿one two', 'en')).toBe(2);
    expect(countTextWords('﻿', 'en')).toBe(0);
  });
});

describe('counting scales with the size of the part', () => {
  it('counts 60,000 paragraphs, thousands of them in Choice/Fallback text boxes, in seconds', () => {
    const box = (t: string) => `<w:txbxContent>${para(run(t))}</w:txbxContent>`;
    const alt =
      `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${box('in a box')}</w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict>${box('in a box')}</w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
    const body = (para(run('two words')) + para(alt)).repeat(15000);
    const started = performance.now();
    const n = countDocxWords(docx(body), 'en');
    expect(performance.now() - started).toBeLessThan(5000);
    // Per repeat: "two words" (2) + "in a box" once (3, not 6); the
    // paragraph holding the alternate content has no text of its own.
    expect(n).toBe(15000 * 5);
  });
});
