import { describe, expect, it } from 'vitest';

import { seg } from './fixture.js';
import { inflectionEndings } from './inflection.js';
import { termKey } from './key.js';
import {
  findMismatches,
  wordSpans,
  type EntryForm,
  type GlossaryTermEntry,
} from './mismatch.js';

const form = (text: string): EntryForm => ({ text, plain: termKey(text) });

const entry = (
  over: {
    source?: string[];
    preferred?: string | null;
    alternatives?: string[];
    forbidden?: string[];
  } = {},
): GlossaryTermEntry => ({
  termId: 1,
  source: (over.source ?? ['invoice']).map(form),
  preferred: over.preferred === null ? null : form(over.preferred ?? 'Rechnung'),
  alternatives: (over.alternatives ?? []).map(form),
  forbidden: (over.forbidden ?? []).map(form),
});

const en_de = { srcLang: 'en', tgtLang: 'de' };
const kinds = (rows: ReturnType<typeof findMismatches>) =>
  rows.map((r) => [r.ord, r.kind, r.found]);

describe('wordSpans', () => {
  it('needs a word boundary on both sides', () => {
    expect(wordSpans('accounting', 'account', [])).toEqual([]);
    expect(wordSpans('my account', 'account', [])).toEqual([[3, 10]]);
    expect(wordSpans('the account.', 'account', [])).toEqual([[4, 11]]);
    expect(wordSpans('l’accord', 'accord', [])).toEqual([[2, 8]]);
  });

  it('finds a later occurrence after a rejected one', () => {
    expect(wordSpans('accounting account', 'account', [])).toEqual([[11, 18]]);
  });

  it('tolerates an ending on the last word only when it is the whole rest of the word', () => {
    expect(wordSpans('zwei rechnungen', 'rechnung', ['en'])).toEqual([[5, 15]]);
    expect(wordSpans('rechnungsnummer', 'rechnung', ['en', 's'])).toEqual([]);
    expect(wordSpans('zwei rechnungen', 'rechnung', [])).toEqual([]);
  });
});

describe('inflectionEndings', () => {
  it('is a closed list per primary subtag, and empty for any other language', () => {
    expect(inflectionEndings('de-AT')).toContain('en');
    expect(inflectionEndings('es-MX')).toEqual(['s', 'es']);
    expect(inflectionEndings('ja')).toEqual([]);
  });
});

describe('findMismatches', () => {
  it('is silent when the target uses the preferred rendering', () => {
    const segs = [seg(0, 'Send the invoice.', { target: 'Senden Sie die Rechnung.' })];
    expect(findMismatches([entry()], segs, en_de)).toEqual([]);
  });

  it('reports a target that lacks the preferred rendering', () => {
    const segs = [seg(0, 'Send the invoice.', { target: 'Senden Sie den Beleg.' })];
    expect(findMismatches([entry()], segs, en_de)).toEqual([
      {
        ord: 0,
        segmentId: 1,
        termId: 1,
        term: 'invoice',
        kind: 'missing_preferred',
        preferred: 'Rechnung',
        found: null,
      },
    ]);
  });

  it('names an acceptable synonym used instead, and still reports it', () => {
    const segs = [seg(0, 'Send the invoice.', { target: 'Senden Sie den Beleg.' })];
    const rows = findMismatches([entry({ alternatives: ['Beleg'] })], segs, en_de);
    expect(kinds(rows)).toEqual([[0, 'missing_preferred', 'Beleg']]);
  });

  it('reports a forbidden rendering, even beside the preferred one', () => {
    const segs = [
      seg(0, 'Send the invoice.', { target: 'Senden Sie die Faktura.' }),
      seg(1, 'Send the invoice.', { target: 'Rechnung oder Faktura.' }),
    ];
    const rows = findMismatches([entry({ forbidden: ['Faktura'] })], segs, en_de);
    expect(kinds(rows)).toEqual([
      [0, 'forbidden', 'Faktura'],
      [1, 'forbidden', 'Faktura'],
    ]);
  });

  it('is one row per segment and term, forbidden first', () => {
    const segs = [seg(0, 'The invoice.', { target: 'Die Faktura.' })];
    expect(findMismatches([entry({ forbidden: ['Faktura'] })], segs, en_de)).toHaveLength(
      1,
    );
  });

  it('does not count a forbidden word that is part of an acceptable rendering', () => {
    const segs = [seg(0, 'Your account.', { target: 'Ihr Kundenkonto Kundenkonto.' })];
    const e: GlossaryTermEntry = {
      ...entry({
        source: ['account'],
        preferred: 'Kundenkonto',
        forbidden: ['Konto'],
      }),
    };
    expect(findMismatches([e], segs, en_de)).toEqual([]);
    const accountOnly: GlossaryTermEntry = {
      ...entry({
        source: ['account'],
        preferred: 'customer account',
        forbidden: ['account'],
      }),
    };
    const ok = [seg(0, 'Your account.', { target: 'Open your customer account.' })];
    expect(findMismatches([accountOnly], ok, { srcLang: 'en', tgtLang: 'en' })).toEqual(
      [],
    );
    const bad = [seg(0, 'Your account.', { target: 'Open your account.' })];
    expect(
      kinds(findMismatches([accountOnly], bad, { srcLang: 'en', tgtLang: 'en' })),
    ).toEqual([[0, 'forbidden', 'account']]);
  });

  it('only looks at segments with a target that has text', () => {
    const segs = [
      seg(0, 'The invoice.'),
      seg(1, 'The invoice.', { target: '   ' }),
      seg(2, 'Another sentence.', { target: 'Ein anderer Satz.' }),
    ];
    expect(findMismatches([entry()], segs, en_de)).toEqual([]);
  });

  it('matches the source by word and case-insensitively, with the source language’s endings', () => {
    const e = entry({ source: ['invoice'] });
    const target = { target: 'Etwas anderes.' };
    expect(
      findMismatches([e], [seg(0, 'Invoices are due.', target)], en_de),
    ).toHaveLength(1);
    expect(findMismatches([e], [seg(0, 'INVOICE.', target)], en_de)).toHaveLength(1);
    expect(findMismatches([e], [seg(0, 'Uninvoiced items.', target)], en_de)).toEqual([]);
  });

  it('accepts inflected German endings on the preferred rendering', () => {
    const segs = [
      seg(0, 'Two invoices.', { target: 'Zwei Rechnungen.' }),
      seg(1, 'The invoice.', { target: 'Der Rechnungsbetrag.' }),
    ];
    expect(kinds(findMismatches([entry()], segs, en_de))).toEqual([
      [1, 'missing_preferred', null],
    ]);
  });

  it('does not stem an irregular form: a missed match is a mismatch, never a pass', () => {
    const e = entry({ source: ['house'], preferred: 'Haus' });
    const segs = [seg(0, 'Two houses.', { target: 'Zwei Häuser.' })];
    expect(kinds(findMismatches([e], segs, en_de))).toEqual([
      [0, 'missing_preferred', null],
    ]);
  });

  it('compares under termKey: NBSP and case do not matter', () => {
    const e = entry({ source: ['free software'], preferred: 'Freie Software' });
    const segs = [seg(0, 'Free software.', { target: 'FREIE SOFTWARE ist gut.' })];
    expect(findMismatches([e], segs, en_de)).toEqual([]);
  });

  it('skips an entry with no preferred rendering unless a forbidden one occurs', () => {
    const e = entry({ preferred: null, forbidden: ['Faktura'] });
    const segs = [
      seg(0, 'The invoice.', { target: 'Der Beleg.' }),
      seg(1, 'The invoice.', { target: 'Die Faktura.' }),
    ];
    expect(kinds(findMismatches([e], segs, en_de))).toEqual([
      [1, 'forbidden', 'Faktura'],
    ]);
  });

  it('joins a target’s adjacent text tokens before looking', () => {
    const s = seg(0, 'The invoice.');
    const tagged = {
      ...s,
      targetTokens: [
        { t: 'text' as const, v: 'Die ' },
        { t: 'text' as const, v: 'Rechnung' },
      ],
    };
    expect(findMismatches([entry()], [tagged], en_de)).toEqual([]);
  });

  it('reports rows in entry order within a segment, whatever order the words come in', () => {
    const a: GlossaryTermEntry = {
      ...entry({ source: ['invoice'], preferred: 'Rechnung' }),
      termId: 1,
    };
    const b: GlossaryTermEntry = {
      ...entry({ source: ['payment'], preferred: 'Zahlung' }),
      termId: 2,
    };
    const segs = [seg(0, 'Payment of the invoice.', { target: 'Etwas.' })];
    expect(findMismatches([a, b], segs, en_de).map((r) => r.termId)).toEqual([1, 2]);
  });

  it('finds a multi-word term by its first word, and an inflected one-word term by its stem', () => {
    const multi = entry({ source: ['free software'], preferred: 'Freie Software' });
    const segs = [
      seg(0, 'Free software is good.', { target: 'Gut.' }),
      seg(1, 'Free speech is good.', { target: 'Gut.' }),
      seg(2, 'Two invoices.', { target: 'Zwei.' }),
    ];
    expect(findMismatches([multi], segs, en_de).map((r) => r.ord)).toEqual([0]);
    expect(findMismatches([entry()], segs, en_de).map((r) => r.ord)).toEqual([2]);
  });
});
