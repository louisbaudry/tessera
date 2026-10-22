import { describe, expect, it } from 'vitest';

import {
  REFERENCE_LABEL_MAX,
  REFERENCE_NAME_MAX,
  referenceDisplayName,
  referenceLabel,
  sniffReferenceType,
} from './reference.js';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('sniffReferenceType', () => {
  it('reads the type from the signature', () => {
    expect(sniffReferenceType(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(
      'application/pdf',
    );
    expect(
      sniffReferenceType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
    ).toBe('image/png');
    expect(sniffReferenceType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffReferenceType(new TextEncoder().encode('GIF89a....'))).toBe('image/gif');
    expect(sniffReferenceType(new TextEncoder().encode('GIF87a....'))).toBe('image/gif');
    expect(
      sniffReferenceType(
        new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '),
      ),
    ).toBe('image/webp');
  });

  it('allows a little junk before %PDF-, not a lot', () => {
    const junk = new TextEncoder().encode(`${'x'.repeat(100)}%PDF-1.4`);
    expect(sniffReferenceType(junk)).toBe('application/pdf');
    const far = new TextEncoder().encode(`${'x'.repeat(2000)}%PDF-1.4`);
    expect(sniffReferenceType(far)).toBeNull();
  });

  it('refuses what can run script, an office file, text and nothing', () => {
    for (const text of [
      '<html><script>alert(1)</script>',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'hello',
      'PK\u0003\u0004',
    ]) {
      expect(sniffReferenceType(new TextEncoder().encode(text)), text).toBeNull();
    }
    expect(sniffReferenceType(new Uint8Array())).toBeNull();
    // RIFF that is not WebP (a WAV).
    expect(
      sniffReferenceType(
        new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt '),
      ),
    ).toBeNull();
  });
});

describe('referenceDisplayName', () => {
  it('keeps the last path segment, never a path', () => {
    expect(referenceDisplayName('C:\\Users\\x\\Style guide.pdf')).toBe('Style guide.pdf');
    expect(referenceDisplayName('../../etc/passwd')).toBe('passwd');
    expect(referenceDisplayName('a/b/')).toBe('reference');
  });

  it('drops control characters and keeps the end of a long name', () => {
    expect(referenceDisplayName('a\u0000b\nc.pdf')).toBe('abc.pdf');
    const long = `${'n'.repeat(300)}.pdf`;
    const name = referenceDisplayName(long);
    expect(name).toHaveLength(REFERENCE_NAME_MAX);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(referenceDisplayName('   ')).toBe('reference');
  });
});

describe('referenceLabel', () => {
  it('is null for none, trimmed for some, and refused when too long', () => {
    expect(referenceLabel(undefined)).toBeNull();
    expect(referenceLabel('  \n ')).toBeNull();
    expect(referenceLabel('  Style guide\u0007 ')).toBe('Style guide');
    expect(referenceLabel('x'.repeat(REFERENCE_LABEL_MAX))).toHaveLength(
      REFERENCE_LABEL_MAX,
    );
    expect(() => referenceLabel('x'.repeat(REFERENCE_LABEL_MAX + 1))).toThrow(RangeError);
  });
});
