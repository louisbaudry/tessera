import { describe, expect, it } from 'vitest';

import { GlossarySession, GlossarySessionError, type SessionFlag } from './session.js';

const flag = (term: string, over: Partial<SessionFlag> = {}): SessionFlag => ({
  key: term.toLowerCase(),
  term,
  termId: null,
  offered: [],
  firstOrd: null,
  ...over,
});

const LANGS = { srcLang: 'en', tgtLang: 'fr' };

describe('GlossarySession — transitions', () => {
  it('derives the kind from what was offered, never from a claim', () => {
    const s = new GlossarySession(LANGS, [
      flag('software', { offered: ['logiciel', 'programme'] }),
      flag('invoice', { offered: ['facture'] }),
    ]);
    s.choose('software', 'Logiciel'); // offered, compared by termKey
    s.choose('invoice', 'note de frais'); // not offered
    expect(s.pending().map((e) => [e.flag.key, e.kind])).toEqual([
      ['software', 'accepted_suggestion'],
      ['invoice', 'custom'],
    ]);
  });

  it('rejects what was offered and not taken, and nothing else', () => {
    const s = new GlossarySession(LANGS, [
      flag('software', { offered: ['logiciel', 'programme', 'appli'] }),
    ]);
    s.choose('software', 'programme');
    expect(s.pending()[0]!.rejected).toEqual(['logiciel', 'appli']);
  });

  it('lets a flag change its mind until the session ends', () => {
    const s = new GlossarySession(LANGS, [flag('a', { termId: 1 })]);
    s.choose('a', 'x');
    s.skip('a');
    expect(s.pending()).toEqual([]);
    s.proposeEdit('a', 'override', 'y');
    s.reopen('a');
    expect(s.pending()).toEqual([]);
    s.proposeEdit('a', 'deprecate', 'z');
    expect(s.pending().map((e) => [e.kind, e.rendering])).toEqual([['deprecation', 'z']]);
  });

  it('proposes an edit only to an entry that exists', () => {
    const s = new GlossarySession(LANGS, [flag('new term'), flag('old', { termId: 4 })]);
    expect(() => s.proposeEdit('new term', 'override', 'x')).toThrow(
      GlossarySessionError,
    );
    s.proposeEdit('old', 'override', 'x');
    expect(() => s.proposeEdit('old', 'nonsense' as 'override', 'x')).toThrow(
      GlossarySessionError,
    );
  });

  it('refuses an empty rendering and a flag it does not have', () => {
    const s = new GlossarySession(LANGS, [flag('a')]);
    expect(() => s.choose('a', '    ')).toThrow(/non-empty/);
    expect(() => s.choose('missing', 'x')).toThrow(/no flag/);
    expect(() => s.skip('missing')).toThrow(GlossarySessionError);
  });

  it('refuses a malformed set of flags', () => {
    expect(() => new GlossarySession(LANGS, [flag('a'), flag('a')])).toThrow(/two flags/);
    expect(() => new GlossarySession(LANGS, [flag('A', { key: 'A' })])).toThrow(
      /termKey/,
    );
    expect(() => new GlossarySession({ srcLang: '', tgtLang: 'fr' }, [])).toThrow(
      /language pair/,
    );
  });
});

describe('GlossarySession — commit', () => {
  /** Three decided, one proposed, two skipped: the card's own scenario. */
  const scenario = () => {
    const s = new GlossarySession(LANGS, [
      flag('a', { offered: ['a1'] }),
      flag('b'),
      flag('c', { offered: ['c1', 'c2'] }),
      flag('d', { termId: 9, offered: ['d1'] }),
      flag('e'),
      flag('f'),
    ]);
    s.choose('a', 'a1');
    s.choose('b', 'custom b');
    s.choose('c', 'c2');
    s.proposeEdit('d', 'override', 'd2');
    s.skip('e');
    // 'f' is left as it was flagged.
    return s;
  };

  it('writes exactly four entries and leaves the two skipped ones to be asked again', () => {
    const s = scenario();
    let written: readonly unknown[] = [];
    const n = s.commit((entries) => {
      written = entries;
    });
    expect(n).toBe(4);
    expect(written).toHaveLength(4);
    expect(s.status).toBe('committed');
    expect(s.remaining().map((f) => f.key)).toEqual(['e', 'f']);
  });

  it('stays open, every decision intact, when the write fails', () => {
    const s = scenario();
    expect(() =>
      s.commit(() => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(s.status).toBe('open');
    expect(s.pending()).toHaveLength(4);
    expect(s.commit(() => undefined)).toBe(4);
  });

  it('refuses everything once committed or discarded', () => {
    const done = scenario();
    done.commit(() => undefined);
    for (const op of [
      () => done.choose('a', 'x'),
      () => done.skip('a'),
      () => done.reopen('a'),
      () => done.commit(() => undefined),
      () => done.discard(),
    ]) {
      expect(op).toThrow(/committed/);
    }
    const dropped = scenario();
    dropped.discard();
    expect(() => dropped.choose('a', 'x')).toThrow(/discarded/);
    expect(dropped.status).toBe('discarded');
  });
});

describe('GlossarySession — serialisation', () => {
  it('round-trips a session in the middle of a decision', () => {
    const s = new GlossarySession(LANGS, [
      flag('a', { offered: ['a1'], firstOrd: 3 }),
      flag('b', { termId: 2 }),
      flag('c'),
    ]);
    s.choose('a', 'a1');
    s.proposeEdit('b', 'deprecate', 'bad');
    s.skip('c');
    const back = GlossarySession.fromJSON(JSON.parse(JSON.stringify(s)));
    expect(back.toJSON()).toEqual(s.toJSON());
    expect(back.pending()).toEqual(s.pending());
    expect(back.remaining().map((f) => f.key)).toEqual(['c']);
  });

  it('keeps a finished session finished', () => {
    const s = new GlossarySession(LANGS, [flag('a')]);
    s.choose('a', 'x');
    s.commit(() => undefined);
    const back = GlossarySession.fromJSON(JSON.parse(JSON.stringify(s)));
    expect(back.status).toBe('committed');
    expect(() => back.skip('a')).toThrow(/committed/);
  });

  it('rejects anything it does not recognise', () => {
    const good = JSON.parse(
      JSON.stringify(new GlossarySession(LANGS, [flag('a')])),
    ) as Record<string, unknown>;
    for (const bad of [
      null,
      'x',
      { ...good, version: 2 },
      { ...good, flags: 'no' },
      { ...good, langs: {} },
      { ...good, closed: 'maybe' },
      { ...good, flags: [{ flag: { key: 'a' }, state: { state: 'flagged' } }] },
      {
        ...good,
        flags: [
          {
            flag: { key: 'a', term: 'a', termId: null, firstOrd: null, offered: [] },
            state: { state: 'wat' },
          },
        ],
      },
    ]) {
      expect(() => GlossarySession.fromJSON(bad)).toThrow(GlossarySessionError);
    }
  });
});
