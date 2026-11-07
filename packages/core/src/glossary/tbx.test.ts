import { describe, expect, it } from 'vitest';

import type { GlossaryExportRow } from './export.js';
import { glossaryTbx, parseTbx, TBX_STATUS_VALUES } from './tbx.js';

const PREF = TBX_STATUS_VALUES.preferredTerm;
const ADM = TBX_STATUS_VALUES.admittedTerm;
const DEP = TBX_STATUS_VALUES.deprecatedTerm;

/** A `<langSet>` of `[term, status]` pairs; a null status is no note at all. */
const set = (lang: string, ...tigs: [string, string | null][]) =>
  `<langSet xml:lang="${lang}">` +
  tigs
    .map(
      ([term, status]) =>
        `<tig><term>${term}</term>${
          status === null
            ? ''
            : `<termNote type="administrativeStatus">${status}</termNote>`
        }</tig>`,
    )
    .join('') +
  `</langSet>`;

/** A file whose `termEntry`s are the given strings, each one concept. */
const file = (...entries: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<martif type="TBX" xml:lang="en"><martifHeader/><text><body>\n` +
  entries.map((e) => `<termEntry>${e}</termEntry>`).join('\n') +
  `\n</body></text></martif>`;

const refusalsOf = (text: string, srcLang = 'en') =>
  parseTbx(text, srcLang).refusals.map((r) => `${r.line}: ${r.message}`);

describe('glossaryTbx', () => {
  it('writes one termEntry per concept, with the status of each rendering', () => {
    const rows: GlossaryExportRow[] = [
      { concept: 1, lang: 'en', term: 'source', status: 'allowed' },
      { concept: 1, lang: 'uk', term: 'джерело', status: 'preferred' },
      { concept: 1, lang: 'uk', term: 'джерела', status: 'forbidden' },
      { concept: 2, lang: 'en', term: 'claim', status: 'preferred' },
    ];
    const xml = glossaryTbx(rows, 'en');
    expect(xml).toContain('<martif type="TBX" xml:lang="en">');
    expect(xml).toContain(
      `<termEntry id="c1">` +
        set('en', ['source', ADM]) +
        set('uk', ['джерело', PREF], ['джерела', DEP]) +
        `</termEntry>`,
    );
    expect(xml.match(/<termEntry /g)).toHaveLength(2);
  });

  it('escapes the markup characters in a term', () => {
    const xml = glossaryTbx([
      { concept: 1, lang: 'en', term: 'A & B <x> "y"', status: 'preferred' },
    ]);
    expect(xml).toContain('<term>A &amp; B &lt;x&gt; &quot;y&quot;</term>');
  });

  it('an empty glossary is a file with no entries, which the parser refuses as empty', () => {
    expect(glossaryTbx([])).toContain('<body>');
    expect(refusalsOf(glossaryTbx([]))).toEqual(['0: the file has no termEntry']);
  });
});

describe('parseTbx', () => {
  it('maps one entry to a row: the source term, the preferred rendering, the deprecated as avoid', () => {
    const parsed = parseTbx(
      file(set('en', ['source', ADM]) + set('uk', ['джерело', PREF], ['джерела', DEP])),
      'en',
    );
    expect(parsed.refusals).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        line: 1,
        term: 'source',
        lang: 'uk',
        rendering: 'джерело',
        status: 'official',
        avoid: ['джерела'],
        keep: false,
      },
    ]);
  });

  it('round-trips what glossaryTbx writes', () => {
    const rows: GlossaryExportRow[] = [
      { concept: 1, lang: 'en', term: 'source', status: 'allowed' },
      { concept: 1, lang: 'uk', term: 'джерело', status: 'preferred' },
      { concept: 1, lang: 'uk', term: 'джерела', status: 'forbidden' },
      { concept: 2, lang: 'en', term: 'claim', status: 'allowed' },
      { concept: 2, lang: 'uk', term: 'твердження', status: 'preferred' },
    ];
    const parsed = parseTbx(glossaryTbx(rows, 'en'), 'en');
    expect(parsed.refusals).toEqual([]);
    expect(parsed.rows.map((r) => [r.term, r.lang, r.rendering, r.avoid])).toEqual([
      ['source', 'uk', 'джерело', ['джерела']],
      ['claim', 'uk', 'твердження', []],
    ]);
  });

  it('decodes entities and matches the source language by its primary subtag', () => {
    const parsed = parseTbx(
      file(set('en-GB', ['A &amp; B', PREF]) + set('de', ['a &lt;b&gt;', PREF])),
      'en',
    );
    expect(parsed.refusals).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      term: 'A & B',
      lang: 'de',
      rendering: 'a <b>',
    });
  });

  it('takes the one admitted rendering when a language has no preferred one', () => {
    const parsed = parseTbx(
      file(set('en', ['source', PREF]) + set('fr', ['source', ADM])),
      'en',
    );
    expect(parsed.refusals).toEqual([]);
    expect(parsed.rows[0]?.rendering).toBe('source');
  });

  it('reads a tig with no status note as admitted', () => {
    const parsed = parseTbx(file(set('en', ['a', PREF]) + set('fr', ['b', null])), 'en');
    expect(parsed.refusals).toEqual([]);
    expect(parsed.rows[0]?.rendering).toBe('b');
  });

  it('a file that is not XML is one refusal for the file', () => {
    expect(refusalsOf('<martif><unclosed>')[0]).toMatch(/^0: not readable XML/);
  });

  describe('refuses, naming the entry', () => {
    it('the root is not martif, there is no body, or there is no entry', () => {
      expect(refusalsOf('<tmx/>')).toEqual(['0: the root element is not martif']);
      expect(refusalsOf('<martif/>')).toEqual([
        '0: the file needs exactly one text body',
      ]);
      expect(refusalsOf(file())).toEqual(['0: the file has no termEntry']);
    });

    it('an entry with no source-language term', () => {
      expect(refusalsOf(file(set('uk', ['джерело', PREF])))).toEqual([
        '1: the entry has no en term',
      ]);
    });

    it('two preferred terms on the source side, or two in the target language', () => {
      expect(
        refusalsOf(file(set('en', ['a', PREF], ['b', PREF]) + set('uk', ['x', PREF]))),
      ).toEqual(['1: the en side needs one preferred term']);
      expect(
        refusalsOf(file(set('en', ['a', PREF]) + set('uk', ['x', PREF], ['y', PREF]))),
      ).toEqual(['1: uk has two preferred terms']);
    });

    it('a target language with several admitted terms and no preferred one, or only deprecated ones', () => {
      expect(
        refusalsOf(file(set('en', ['a', PREF]) + set('uk', ['x', ADM], ['y', ADM]))),
      ).toEqual(['1: uk has 2 admitted terms and no preferred one']);
      expect(refusalsOf(file(set('en', ['a', PREF]) + set('uk', ['x', DEP])))).toEqual([
        '1: uk has no usable term',
      ]);
    });

    it('a status the subset does not read', () => {
      expect(refusalsOf(file(set('en', ['a', 'approved-by-committee'])))).toEqual([
        '1: status "approved-by-committee" is not one this subset reads',
      ]);
    });

    it('a bad xml:lang, a tig with no term, a language in two langSets', () => {
      expect(
        refusalsOf(file(set('en', ['a', PREF]) + '<langSet xml:lang="u k"/>')),
      ).toEqual(['1: a langSet has no valid xml:lang ("u k")']);
      expect(
        refusalsOf(
          file(set('en', ['a', PREF]) + '<langSet xml:lang="uk"><tig/></langSet>'),
        ),
      ).toEqual(['1: a uk tig has no term']);
      expect(
        refusalsOf(
          file(set('en', ['a', PREF]) + set('uk', ['x', PREF]) + set('uk', ['y', PREF])),
        ),
      ).toEqual(['1: language uk appears in two langSets']);
    });

    it('refuses the file whole: a good entry is not returned beside a bad one', () => {
      const parsed = parseTbx(
        file(set('en', ['a', PREF]) + set('uk', ['x', PREF]), set('uk', ['y', PREF])),
        'en',
      );
      expect(parsed.rows).toEqual([]);
      expect(parsed.refusals).toEqual([{ line: 2, message: 'the entry has no en term' }]);
    });
  });
});
