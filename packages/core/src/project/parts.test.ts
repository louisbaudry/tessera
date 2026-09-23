import { describe, expect, it } from 'vitest';

import { toDocPart, toPartName } from './parts.js';

describe('part names ↔ DocPart', () => {
  it.each([
    ['word/document.xml', 'document'],
    ['word/footnotes.xml', 'footnotes'],
    ['word/endnotes.xml', 'endnotes'],
    ['word/header1.xml', 'header1'],
    ['word/header12.xml', 'header12'],
    ['word/footer3.xml', 'footer3'],
  ] as const)('%s ↔ %s', (partName, docPart) => {
    expect(toDocPart(partName)).toBe(docPart);
    expect(toPartName(docPart)).toBe(partName);
  });

  it('refuses a part it does not know', () => {
    expect(() => toDocPart('word/comments.xml')).toThrow(/unrecognised/);
    expect(() => toPartName('comments' as never)).toThrow(/unrecognised/);
  });
});
