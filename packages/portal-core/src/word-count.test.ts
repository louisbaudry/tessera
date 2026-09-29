import { writeDocx } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { countWords, estimateWordCount } from './word-count.js';

const est = (filename: string, bytes: Uint8Array, srcLang = 'en') =>
  estimateWordCount({ filename, bytes, srcLang });

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const strToU8 = (s: string) => new TextEncoder().encode(s);
const docx = writeDocx({
  parts: [
    { name: '[Content_Types].xml', data: strToU8('<Types/>') },
    {
      name: 'word/document.xml',
      data: strToU8(
        `<w:document ${NS}><w:body><w:p><w:r><w:t>three small words</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ],
});

describe('countWords', () => {
  it('is the definition in core: hyphenated and punctuated words are one', () => {
    expect(countWords('an e-mail, l’homme — 1,000.50')).toBe(4);
  });
});

describe('estimateWordCount', () => {
  it('counts a .txt', () => {
    expect(est('a.txt', strToU8('one two three'))).toBe(3);
  });

  it('counts a .docx through core', () => {
    expect(est('a.docx', docx)).toBe(3);
  });

  it('goes by the name and the bytes, and is case-insensitive about the extension', () => {
    expect(est('A.TXT', strToU8('one two'))).toBe(2);
    expect(est('A.DOCX', docx)).toBe(3);
  });

  it('is null for a file that is not what its extension says', () => {
    expect(est('a.docx', strToU8('one two three'))).toBeNull();
    expect(est('a.docx', new Uint8Array(0))).toBeNull();
    expect(est('a.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull();
  });

  it('is null for formats core has no filter for', () => {
    for (const name of ['a.pptx', 'a.xlsx', 'a.pdf', 'a.doc', 'noext', '']) {
      expect(est(name, docx), name).toBeNull();
    }
  });

  it('is null for an unspaced source language', () => {
    expect(est('a.txt', strToU8('one two'), 'ja')).toBeNull();
    expect(est('a.docx', docx, 'zh-CN')).toBeNull();
  });

  describe('.txt encodings', () => {
    it('a UTF-8 BOM neither counts nor joins', () => {
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('one two')]);
      expect(est('a.txt', bytes)).toBe(2);
    });

    it('UTF-16 with a BOM is null: not valid UTF-8', () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0x6f, 0x00, 0x6e, 0x00, 0x65, 0x00]);
      expect(est('a.txt', bytes)).toBeNull();
    });

    it('UTF-16 without a BOM is null: decodes as UTF-8 but is full of NULs', () => {
      const ascii = 'one two three';
      const bytes = new Uint8Array(ascii.length * 2);
      [...ascii].forEach((ch, i) => (bytes[i * 2] = ch.charCodeAt(0)));
      expect(est('a.txt', bytes)).toBeNull();
    });

    it('malformed UTF-8 is null', () => {
      expect(est('a.txt', new Uint8Array([0x6f, 0xff, 0x6e]))).toBeNull();
    });

    it('an empty file is zero words, not unknown', () => {
      expect(est('a.txt', new Uint8Array(0))).toBe(0);
    });
  });
});
