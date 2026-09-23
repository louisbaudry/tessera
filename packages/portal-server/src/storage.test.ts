import { describe, expect, it } from 'vitest';

import { attachmentDisposition, displayFilename, mintStoredName } from './storage.js';

describe('displayFilename', () => {
  it('keeps only the last path segment, whichever separator the OS used', () => {
    expect(displayFilename('report.docx')).toBe('report.docx');
    expect(displayFilename('../../etc/passwd')).toBe('passwd');
    expect(displayFilename('C:\\Users\\ada\\Desktop\\brief.pdf')).toBe('brief.pdf');
    expect(displayFilename('nested/dir/name with spaces.txt')).toBe(
      'name with spaces.txt',
    );
  });

  it('falls back to a placeholder when nothing usable is left', () => {
    expect(displayFilename('')).toBe('file');
    expect(displayFilename('..')).toBe('file');
    expect(displayFilename('dir/')).toBe('file');
    expect(displayFilename('   ')).toBe('file');
  });
});

describe('attachmentDisposition', () => {
  it('quotes an ASCII name as-is and repeats it percent-encoded', () => {
    expect(attachmentDisposition('report.docx')).toBe(
      `attachment; filename="report.docx"; filename*=UTF-8''report.docx`,
    );
  });

  it('never lets a quote, backslash or non-ASCII character into the quoted fallback', () => {
    const header = attachmentDisposition('r\u00e9sum\u00e9 "final".docx');
    expect(header).toBe(
      `attachment; filename="r_sum_ _final_.docx"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.docx`,
    );
  });
});

describe('mintStoredName', () => {
  it('mints a fresh opaque name each time, with nothing path-like in it', () => {
    const a = mintStoredName();
    const b = mintStoredName();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
