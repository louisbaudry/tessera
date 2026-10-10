import { describe, expect, it } from 'vitest';

import { glossaryCsv } from './export.js';

describe('glossaryCsv', () => {
  it('writes a header, then one CRLF-ended row per rendering', () => {
    const csv = glossaryCsv([
      { concept: 1, lang: 'en', term: 'invoice', status: 'allowed' },
      { concept: 1, lang: 'es', term: 'factura', status: 'preferred' },
    ]);
    expect(csv).toBe(
      'concept,lang,term,status\r\n1,en,invoice,allowed\r\n1,es,factura,preferred\r\n',
    );
  });

  it('is just the header for an empty glossary', () => {
    expect(glossaryCsv([])).toBe('concept,lang,term,status\r\n');
  });

  it('quotes a term with a comma and neutralises one that starts like a formula', () => {
    const csv = glossaryCsv([
      { concept: 1, lang: 'en', term: 'a, b', status: 'allowed' },
      { concept: 2, lang: 'en', term: '=HYPERLINK("x")', status: 'forbidden' },
    ]);
    expect(csv).toContain('1,en,"a, b",allowed');
    expect(csv).toContain('2,en,"\'=HYPERLINK(""x"")",forbidden');
  });
});
