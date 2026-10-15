import { describe, expect, it } from 'vitest';

import type { GlossaryTermEntry } from '../glossary/mismatch.js';
import { termKey } from '../glossary/key.js';
import { draftTerms } from './terms.js';

const form = (text: string) => ({ text, plain: termKey(text) });
const entry = (
  termId: number,
  source: string[],
  preferred: string | null,
  forbidden: string[] = [],
): GlossaryTermEntry => ({
  termId,
  source: source.map(form),
  preferred: preferred === null ? null : form(preferred),
  alternatives: [],
  forbidden: forbidden.map(form),
});

const text = (v: string) => [{ t: 'text' as const, v }];

describe('draftTerms', () => {
  const entries = [
    entry(1, ['invoice'], 'factura', ['cuenta']),
    entry(2, ['purchase order', 'PO'], 'orden de compra'),
    entry(3, ['ledger'], null, ['libro']),
  ];

  it('finds the terms whose source form is in the segment, in entry order', () => {
    expect(draftTerms(entries, text('Send the PO and the invoices.'), 'en')).toEqual([
      { source: 'invoice', preferred: 'factura', forbidden: ['cuenta'] },
      { source: 'PO', preferred: 'orden de compra', forbidden: [] },
    ]);
  });

  it('matches whole words only, case-folded, with a tolerated ending', () => {
    expect(draftTerms(entries, text('An INVOICE arrived.'), 'en')).toHaveLength(1);
    expect(draftTerms(entries, text('The invoicer is new.'), 'en')).toEqual([]);
    expect(draftTerms(entries, text('Copy the PO.'), 'en')).toHaveLength(1);
    expect(draftTerms(entries, text('The POST request.'), 'en')).toHaveLength(0);
    // The ending is tolerated, as the mismatch matcher does: POs is PO.
    expect(draftTerms(entries, text('Both POs are late.'), 'en')).toHaveLength(1);
  });

  it('carries a forbidden-only entry with no preferred rendering', () => {
    expect(draftTerms(entries, text('Open the ledger.'), 'en')).toEqual([
      { source: 'ledger', preferred: null, forbidden: ['libro'] },
    ]);
  });

  it('finds a term across a tag boundary, because only the text is searched', () => {
    const tokens = [
      { t: 'text' as const, v: 'Pay the ' },
      { t: 'open' as const, id: 1, fmt: 1 },
      { t: 'text' as const, v: 'invoice' },
      { t: 'close' as const, id: 1 },
    ];
    expect(draftTerms(entries, tokens, 'en')).toHaveLength(1);
  });

  it('returns nothing for a segment with no text', () => {
    expect(draftTerms(entries, [], 'en')).toEqual([]);
  });
});
