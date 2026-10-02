import { describe, expect, it } from 'vitest';

import { extractCandidates } from './candidates.js';
import { repeat, seg } from './fixture.js';

const terms = (c: { term: string; occurrences: number }[]) =>
  c.map((x) => `${x.term}×${x.occurrences}`);

describe('extractCandidates — what counts', () => {
  it('finds a term repeated at least three times, and not one repeated twice', () => {
    const c = extractCandidates(
      [
        seg(0, 'The software crashed.'),
        seg(1, 'Update the software today.'),
        seg(2, 'The software is free, the licence is not.'),
        seg(3, 'Read the licence.'),
      ],
      { srcLang: 'en' },
    );
    expect(terms(c)).toEqual(['software×3']);
  });

  it('honours minOccurrences', () => {
    const segs = [seg(0, 'Read the licence.'), seg(1, 'Sign the licence.')];
    expect(extractCandidates(segs, { srcLang: 'en' })).toEqual([]);
    expect(terms(extractCandidates(segs, { srcLang: 'en', minOccurrences: 2 }))).toEqual([
      'licence×2',
    ]);
  });

  it('counts spellings that normalise alike as one term, shown as first written', () => {
    const c = extractCandidates(
      [
        seg(0, 'Logiciel libre.'),
        seg(1, 'Un logiciel libre est utile.'), // NBSP
        seg(2, 'Le LOGICIEL LIBRE est gratuit.'),
      ],
      { srcLang: 'fr' },
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      key: 'logiciel libre',
      term: 'Logiciel libre',
      occurrences: 3,
    });
  });

  it('lists every segment it occurs in once, ascending', () => {
    const c = extractCandidates(
      [
        seg(0, 'invoice invoice'),
        seg(1, 'other'),
        seg(2, 'the invoice'),
        seg(5, 'an invoice'),
      ],
      { srcLang: 'en' },
    );
    expect(c[0]).toMatchObject({ key: 'invoice', occurrences: 4, ords: [0, 2, 5] });
  });

  it('works for a region tag by its primary subtag', () => {
    const segs = repeat(0, 3, 'La factura.');
    expect(terms(extractCandidates(segs, { srcLang: 'es-ES' }))).toEqual(['factura×3']);
  });

  it('refuses a language it has no stopwords for, as rulesFor does', () => {
    expect(() => extractCandidates(repeat(0, 3, 'x'), { srcLang: 'ja' })).toThrow(
      /No stopword list/,
    );
  });
});

describe('extractCandidates — what does not', () => {
  it('drops an n-gram that begins or ends with a stopword', () => {
    const c = extractCandidates(repeat(0, 3, 'the payment of the invoice'), {
      srcLang: 'en',
    });
    // "of the invoice", "payment of the" and "the payment" are out; "payment
    // of the invoice" is four words, over maxWords.
    expect(terms(c).sort()).toEqual(['invoice×3', 'payment×3']);
  });

  it('never spans punctuation', () => {
    const c = extractCandidates(repeat(0, 3, 'Invoice, tax receipt (copy).'), {
      srcLang: 'en',
    });
    // Not "invoice tax", not "receipt copy": a comma and a bracket end the run.
    expect(terms(c).sort()).toEqual(['Invoice×3', 'copy×3', 'tax receipt×3']);
  });

  it('does not take a number for a term', () => {
    const c = extractCandidates(repeat(0, 3, 'Total 2024 and 3.5 units.'), {
      srcLang: 'en',
    });
    expect(terms(c).sort()).toEqual(['Total×3', 'units×3']);
  });

  it('reads through an elision and keeps the stem as the term', () => {
    const c = extractCandidates(repeat(0, 3, "L'accord."), { srcLang: 'fr' });
    // `l` is a stopword, so "L'accord" cannot begin a term; "accord" can.
    expect(terms(c)).toEqual(['accord×3']);
  });

  it('skips locked segments and a text box’s fallback copy', () => {
    const c = extractCandidates(
      [
        seg(0, 'invoice'),
        seg(1, 'invoice', { locked: true }),
        seg(2, 'invoice', { status: 'locked' }),
        seg(3, 'invoice', { fallbackCopy: true }),
        seg(4, 'invoice'),
      ],
      { srcLang: 'en' },
    );
    expect(c).toEqual([]);
  });
});

describe('extractCandidates — a longer term absorbs the shorter ones it covers', () => {
  it('"tax invoice" ×4 absorbs "invoice" ×4', () => {
    const c = extractCandidates(repeat(0, 4, 'Tax invoice.'), { srcLang: 'en' });
    expect(terms(c)).toEqual(['Tax invoice×4']);
  });

  it('keeps "invoice" ×7 when only four of them are inside "tax invoice"', () => {
    const c = extractCandidates(
      [...repeat(0, 4, 'Tax invoice.'), ...repeat(4, 3, 'Invoice.')],
      { srcLang: 'en' },
    );
    expect(terms(c)).toContain('Tax invoice×4');
    expect(terms(c)).toContain('invoice×7');
  });

  it('drops a shorter term left with fewer than minOccurrences on its own', () => {
    const c = extractCandidates(
      [...repeat(0, 4, 'Tax invoice.'), ...repeat(4, 2, 'Invoice.')],
      { srcLang: 'en' },
    );
    expect(terms(c)).toContain('Tax invoice×4');
    expect(terms(c).some((t) => t.startsWith('invoice'))).toBe(false);
  });

  it('absorbs through a chain: a three-word term covers its bigram and its words', () => {
    const c = extractCandidates(repeat(0, 3, 'Open the Santa Cruz office.'), {
      srcLang: 'en',
    });
    expect(terms(c)).toContain('Santa Cruz office×3');
    expect(terms(c)).not.toContain('Santa Cruz×3');
    expect(terms(c)).not.toContain('Santa×3');
  });
});

describe('extractCandidates — honorifics and place names, as a manuscript has them', () => {
  const sentences = [
    'Mons. Pérez visitó Santa Cruz de Tenerife.',
    'El Excmo. Sr. Obispo bendijo Santa Cruz de Tenerife.',
    'Santa Cruz de Tenerife lo recibió.',
    'Mons. Pérez regresó a Sevilla.',
    'Sevilla recibió al Excmo. Sr. Obispo.',
    'Mons. Pérez escribió desde Sevilla.',
    'El Excmo. Sr. Obispo partió.',
  ];
  const c = extractCandidates(
    sentences.map((s, i) => seg(i, s)),
    { srcLang: 'es' },
  );

  it('finds the honorifics and the places', () => {
    const keys = c.map((x) => x.key);
    expect(keys).toContain('mons'); // the full stop is punctuation after the word
    expect(keys).toContain('excmo');
    expect(keys).toContain('sevilla');
    expect(keys).toContain('pérez');
  });

  it('a stopword may sit inside a term but never begin or end one', () => {
    const keys = c.map((x) => x.key);
    expect(keys).toContain('cruz de tenerife');
    expect(keys).not.toContain('de');
    expect(keys).not.toContain('de tenerife');
    expect(keys).not.toContain('tenerife'); // all three are inside "cruz de tenerife"
  });

  it('fragments a four-word name at the default maxWords, and keeps it whole at 4', () => {
    // Known limit, recorded in smart-glossary-spec.md §4.1: at maxWords 3 the
    // name is two overlapping terms, and the panel offers both.
    expect(c.map((x) => x.key)).toContain('santa cruz');
    const wide = extractCandidates(
      sentences.map((s, i) => seg(i, s)),
      { srcLang: 'es', maxWords: 4 },
    );
    const keys = wide.map((x) => x.key);
    expect(keys).toContain('santa cruz de tenerife');
    expect(keys).not.toContain('santa cruz');
    expect(keys).not.toContain('cruz de tenerife');
  });

  it('is ordered most-repeated first, then longer, then by key', () => {
    const counts = c.map((x) => x.occurrences);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
