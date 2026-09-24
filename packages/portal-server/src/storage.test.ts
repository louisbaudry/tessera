import { describe, expect, it } from 'vitest';

import { displayFilename, mintStoredName } from './storage.js';

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

describe('mintStoredName', () => {
  it('mints a fresh opaque name each time, with nothing path-like in it', () => {
    const a = mintStoredName();
    const b = mintStoredName();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
