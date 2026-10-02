import { describe, expect, it } from 'vitest';

import { alignRequestFor, StaticTermAligner } from './align.js';
import type { Candidate } from './candidates.js';
import { seg } from './fixture.js';

const LANGS = { srcLang: 'en', tgtLang: 'es' };

describe('StaticTermAligner', () => {
  const rendering = { text: 'factura', ords: [0], confidence: 0.9 };

  it('answers from its table by termKey, so spelling does not matter', async () => {
    const aligner = new StaticTermAligner({ Invoice: [rendering] });
    const result = await aligner.align({ ...LANGS, term: 'INVOICE', pairs: [] });
    expect(result.renderings).toEqual([rendering]);
  });

  it('says it found nothing for a term it does not know', async () => {
    const aligner = new StaticTermAligner({ invoice: [rendering] });
    expect(
      (await aligner.align({ ...LANGS, term: 'tax', pairs: [] })).renderings,
    ).toEqual([]);
  });

  it('keeps every request it was asked, so a test can say what was never asked', async () => {
    const aligner = new StaticTermAligner({});
    expect(aligner.requests).toEqual([]);
    await aligner.align({ ...LANGS, term: 'a', pairs: [] });
    await aligner.align({ ...LANGS, term: 'b', pairs: [] });
    expect(aligner.requests.map((q) => q.term)).toEqual(['a', 'b']);
  });
});

describe('alignRequestFor', () => {
  const candidate: Candidate = {
    key: 'invoice',
    term: 'invoice',
    occurrences: 3,
    ords: [0, 2, 3],
    words: 1,
  };

  it('pairs the candidate’s segments as normalised plain text, in order', () => {
    const request = alignRequestFor(
      candidate,
      [
        seg(0, 'The  invoice.', { target: 'La factura.' }),
        seg(1, 'Unrelated.', { target: 'No.' }),
        seg(2, 'Pay the invoice.', { target: 'Pague la factura.' }),
        seg(3, 'An invoice.', { target: 'Una factura.' }),
      ],
      LANGS,
    );
    expect(request).toEqual({
      ...LANGS,
      term: 'invoice',
      pairs: [
        { ord: 0, source: 'The invoice.', target: 'La factura.' },
        { ord: 2, source: 'Pay the invoice.', target: 'Pague la factura.' },
        { ord: 3, source: 'An invoice.', target: 'Una factura.' },
      ],
    });
  });

  it('leaves out a segment with no target yet: detection runs over a finished draft', () => {
    const request = alignRequestFor(
      candidate,
      [
        seg(0, 'The invoice.'),
        seg(2, 'Pay the invoice.', { target: 'Pague la factura.' }),
      ],
      LANGS,
    );
    expect(request.pairs.map((p) => p.ord)).toEqual([2]);
  });
});
