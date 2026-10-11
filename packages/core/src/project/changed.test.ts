import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { countDocxWords } from './count.js';
import { countChangedDocxWords } from './changed.js';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

function docx(body: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    ),
  });
}
const para = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const V1 = docx(
  para('The first sentence is unchanged. The second sentence stays too.') +
    para('A paragraph that will be edited by the client.'),
);

describe('countChangedDocxWords', () => {
  it('counts nothing as changed when the file is the same', () => {
    expect(countChangedDocxWords(V1, V1, 'en')).toEqual({ words: 19, changedWords: 0 });
  });

  it('counts only the sentences that are new or different', () => {
    const v2 = docx(
      para('The first sentence is unchanged. The second sentence stays too.') +
        para('A paragraph that was rewritten by the client.') +
        para('Brand new closing line here.'),
    );
    // 8 words in the rewritten sentence, 5 in the new paragraph.
    expect(countChangedDocxWords(v2, V1, 'en')).toEqual({
      words: 5 + 5 + 8 + 5,
      changedWords: 8 + 5,
    });
  });

  it('judges a sentence, not a paragraph: one edited sentence leaves its neighbour unchanged', () => {
    const v2 = docx(
      para('The first sentence is unchanged. The second sentence now differs.') +
        para('A paragraph that will be edited by the client.'),
    );
    expect(countChangedDocxWords(v2, V1, 'en')).toEqual({ words: 19, changedWords: 5 });
  });

  it('does not mind where an unchanged sentence moved to', () => {
    const v2 = docx(
      para('A paragraph that will be edited by the client.') +
        para('The first sentence is unchanged. The second sentence stays too.'),
    );
    expect(countChangedDocxWords(v2, V1, 'en')?.changedWords).toBe(0);
  });

  it('agrees with the plain counter on the total', () => {
    const v2 = docx(para('Some other text, entirely. And a second sentence.'));
    expect(countChangedDocxWords(v2, V1, 'en')?.words).toBe(countDocxWords(v2, 'en'));
  });

  it('is null for a source language that does not space its words', () => {
    expect(countChangedDocxWords(V1, V1, 'zh')).toBeNull();
  });

  it('is null for a source language with no segmentation rules, never a throw', () => {
    expect(countChangedDocxWords(V1, V1, 'xx')).toBeNull();
  });

  it('is null when either file is not a DOCX', () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    expect(countChangedDocxWords(junk, V1, 'en')).toBeNull();
    expect(countChangedDocxWords(V1, junk, 'en')).toBeNull();
  });

  it('works on a real-world fixture: against itself nothing changed, against nothing like it, all did', () => {
    const dir = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../fixtures/docx',
    );
    const real = new Uint8Array(readFileSync(join(dir, 'prose-short.docx')));
    const total = countDocxWords(real, 'en');
    expect(total).not.toBeNull();
    const same = countChangedDocxWords(real, real, 'en');
    expect(same?.changedWords).toBe(0);
    const other = countChangedDocxWords(real, docx(para('Nothing alike at all.')), 'en');
    expect(other?.changedWords).toBe(other?.words);
  });
});
