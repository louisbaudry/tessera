import { describe, expect, it } from 'vitest';

import { alignRequestFor, StaticTermAligner, type AlignResult } from './align.js';
import { extractCandidates, type Candidate } from './candidates.js';
import { seg } from './fixture.js';
import { flagTerms, toSessionFlag, type GlossaryLookup } from './flag.js';
import { GlossarySession } from './session.js';

const cand = (term: string, ords: number[] = [0, 1, 2]): Candidate => ({
  key: term.toLowerCase(),
  term,
  occurrences: ords.length,
  ords,
  words: term.split(' ').length,
});

const none: GlossaryLookup = () => null;
const aligned = (entries: Record<string, AlignResult['renderings']>) =>
  new Map(Object.entries(entries).map(([k, renderings]) => [k, { renderings }]));
const r = (text: string, ords: number[], confidence = 0.9) => ({
  text,
  ords,
  confidence,
});

describe('flagTerms — with alignments', () => {
  it('flags two distinct renderings as inconsistent', () => {
    const flags = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('factura', [0, 1]), r('recibo', [2])] }),
      none,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ key: 'invoice', reasons: ['inconsistent'] });
    expect(flags[0]!.renderings.map((x) => x.text)).toEqual(['factura', 'recibo']);
  });

  it('does not flag one confident rendering', () => {
    expect(
      flagTerms([cand('invoice')], aligned({ invoice: [r('factura', [0, 1, 2])] }), none),
    ).toEqual([]);
  });

  it('flags one rendering the aligner is not sure of, at the threshold exclusive', () => {
    const run = (confidence: number, minConfidence?: number) =>
      flagTerms(
        [cand('invoice')],
        aligned({ invoice: [r('factura', [0, 1, 2], confidence)] }),
        none,
        minConfidence === undefined ? {} : { minConfidence },
      );
    expect(run(0.5)[0]!.reasons).toEqual(['uncertain']);
    expect(run(0.7)).toEqual([]); // default 0.7 is the first confident value
    expect(run(0.7, 0.8)[0]!.reasons).toEqual(['uncertain']);
  });

  it('treats spellings that normalise alike as one rendering', () => {
    const flags = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('Factura', [0]), r('factura ', [1, 2]), r('FACTURA', [])] }),
      none,
    );
    expect(flags).toEqual([]);
  });

  it('merges them as one rendering: segments united, best confidence, the commoner spelling shown', () => {
    const flags = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('Factura', [0], 0.3), r('factura', [1, 2], 0.6)] }),
      none,
    );
    expect(flags[0]!.renderings).toEqual([r('factura', [0, 1, 2], 0.6)]);
    expect(flags[0]!.reasons).toEqual(['uncertain']);
  });

  it('does not flag a term the aligner found nothing for', () => {
    expect(flagTerms([cand('invoice')], aligned({}), none)).toEqual([]);
    expect(flagTerms([cand('invoice')], aligned({ invoice: [] }), none)).toEqual([]);
  });

  it('flags a rendering that differs from the glossary’s preferred one, even a single confident one', () => {
    const glossary: GlossaryLookup = (key) =>
      key === 'invoice' ? { termId: 7, preferred: 'Factura' } : null;
    const differs = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('recibo', [0, 1, 2])] }),
      glossary,
    );
    expect(differs[0]).toMatchObject({
      reasons: ['glossary_mismatch'],
      entry: { termId: 7 },
    });
    const matches = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('factura', [0, 1, 2])] }),
      glossary,
    );
    expect(matches).toEqual([]);
  });

  it('gives both reasons when it is inconsistent and the glossary disagrees', () => {
    const glossary: GlossaryLookup = () => ({ termId: 7, preferred: 'factura' });
    const flags = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('factura', [0, 1]), r('recibo', [2])] }),
      glossary,
    );
    expect(flags[0]!.reasons).toEqual(['inconsistent', 'glossary_mismatch']);
  });

  it('cannot call a mismatch where the glossary has no preferred rendering yet', () => {
    const glossary: GlossaryLookup = () => ({ termId: 7, preferred: null });
    expect(
      flagTerms(
        [cand('invoice')],
        aligned({ invoice: [r('recibo', [0, 1, 2])] }),
        glossary,
      ),
    ).toEqual([]);
  });

  it('keeps the candidates’ order', () => {
    const flags = flagTerms(
      [cand('b'), cand('a'), cand('c')],
      aligned({
        a: [r('x', [0]), r('y', [1])],
        b: [r('x', [0]), r('y', [1])],
        c: [r('x', [0]), r('y', [1])],
      }),
      none,
    );
    expect(flags.map((f) => f.key)).toEqual(['b', 'a', 'c']);
  });
});

describe('flagTerms — without alignments (Stage 2 skipped, §4.2)', () => {
  it('flags every repeated, undecided candidate as unaligned, with no renderings', () => {
    const flags = flagTerms([cand('invoice'), cand('tax')], null, none);
    expect(flags.map((f) => [f.key, f.reasons, f.renderings])).toEqual([
      ['invoice', ['unaligned'], []],
      ['tax', ['unaligned'], []],
    ]);
  });

  it('does not ask again about a term the glossary has decided', () => {
    const glossary: GlossaryLookup = (key) =>
      key === 'invoice'
        ? { termId: 1, preferred: 'factura' }
        : { termId: 2, preferred: null };
    const flags = flagTerms([cand('invoice'), cand('tax')], null, glossary);
    expect(flags.map((f) => f.key)).toEqual(['tax']);
  });
});

describe('the pipeline on a hand-built inconsistent draft (backlog #40’s done-when)', () => {
  // EN → ES. "invoice" is rendered two ways, "customer" one way, throughout.
  const pairs: [string, string][] = [
    ['Send the invoice to the customer.', 'Envíe la factura al cliente.'],
    ['The invoice is overdue.', 'La factura está vencida.'],
    ['Pay the invoice today.', 'Pague el recibo hoy.'],
    ['The customer agreed.', 'El cliente aceptó.'],
    ['Call the customer.', 'Llame al cliente.'],
  ];
  const segments = pairs.map(([source, target], i) => seg(i, source, { target }));

  it('flags exactly the inconsistent term and nothing else', async () => {
    const candidates = extractCandidates(segments, { srcLang: 'en' });
    expect(candidates.map((c) => c.key).sort()).toEqual(['customer', 'invoice']);

    const aligner = new StaticTermAligner({
      invoice: [r('factura', [0, 1]), r('recibo', [2])],
      customer: [r('cliente', [0, 3, 4])],
    });
    const alignments = new Map<string, AlignResult>();
    for (const c of candidates) {
      alignments.set(
        c.key,
        await aligner.align(
          alignRequestFor(c, segments, { srcLang: 'en', tgtLang: 'es' }),
        ),
      );
    }

    const flags = flagTerms(candidates, alignments, none);
    expect(flags.map((f) => [f.key, f.reasons])).toEqual([['invoice', ['inconsistent']]]);
    expect(flags[0]!.ords).toEqual([0, 1, 2]);
  });
});

describe('toSessionFlag', () => {
  it('offers the renderings most-used first and records where the term first occurs', () => {
    const [flag] = flagTerms(
      [
        cand(
          'invoice',
          [4, 2, 9].sort((a, b) => a - b),
        ),
      ],
      aligned({ invoice: [r('recibo', [9]), r('factura', [2, 4])] }),
      none,
    );
    expect(toSessionFlag(flag!)).toEqual({
      key: 'invoice',
      term: 'invoice',
      termId: null,
      offered: ['factura', 'recibo'],
      firstOrd: 2,
    });
  });

  it('adds the glossary’s preferred rendering last when the aligner did not find it', () => {
    const glossary: GlossaryLookup = () => ({ termId: 5, preferred: 'factura' });
    const [flag] = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('recibo', [0, 1]), r('nota', [2])] }),
      glossary,
    );
    const session = toSessionFlag(flag!);
    expect(session.offered).toEqual(['recibo', 'nota', 'factura']);
    expect(session.termId).toBe(5);
  });

  it('does not add it twice when the aligner did find it', () => {
    const glossary: GlossaryLookup = () => ({ termId: 5, preferred: 'Factura' });
    const [flag] = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('factura', [0, 1]), r('recibo', [2])] }),
      glossary,
    );
    expect(toSessionFlag(flag!).offered).toEqual(['factura', 'recibo']);
  });

  it('is what GlossarySession takes: choosing an offered rendering is an accepted suggestion', () => {
    const [flag] = flagTerms(
      [cand('invoice')],
      aligned({ invoice: [r('factura', [0, 1]), r('recibo', [2])] }),
      none,
    );
    const session = new GlossarySession({ srcLang: 'en', tgtLang: 'es' }, [
      toSessionFlag(flag!),
    ]);
    session.choose('invoice', 'Factura');
    expect(session.pending().map((e) => [e.kind, e.rejected])).toEqual([
      ['accepted_suggestion', ['recibo']],
    ]);
  });

  it('an unaligned flag has nothing on offer, and a free-text entry is custom', () => {
    const [flag] = flagTerms([cand('invoice')], null, none);
    const session = new GlossarySession({ srcLang: 'en', tgtLang: 'es' }, [
      toSessionFlag(flag!),
    ]);
    expect(toSessionFlag(flag!).offered).toEqual([]);
    session.choose('invoice', 'factura');
    expect(session.pending()[0]!.kind).toBe('custom');
  });
});
