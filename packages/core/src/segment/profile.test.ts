import { describe, expect, it } from 'vitest';

import {
  defaultProfile,
  mergeListIntoDelta,
  parseProfileDelta,
  ProfileError,
  resolveProfile,
  ruleProblems,
  serializeProfileDelta,
  type ProfileDelta,
} from './profile.js';
import { rulesFor } from './rules.js';
import { findBoundaries } from './segmenter.js';
import { exportSrx, importSrx } from './srx.js';
import {
  exportResourceList,
  importResourceList,
  parseResourceList,
  serializeResourceList,
} from './trados-lists.js';

/** Boundary helper mirroring the one in segmenter.test.ts. */
function split(text: string, rules: Parameters<typeof findBoundaries>[1]): string[] {
  const cuts = findBoundaries(text, rules);
  const out: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    out.push(text.slice(from, cut).trim());
    from = cut;
  }
  out.push(text.slice(from).trim());
  return out.filter((s) => s.length > 0);
}

describe('profile layering', () => {
  it('an empty delta changes nothing', () => {
    // The built-ins and an unmodified profile must segment identically —
    // otherwise adding the profile layer silently changed behaviour.
    const texts = [
      'Está aquí. ¿Dónde vamos?',
      'Habló el Sr. Gómez y la Sra. Ruiz ayer.',
      'It grew 3.14 percent. Then it fell.',
    ];
    for (const text of texts) {
      expect(findBoundaries(text, resolveProfile('es'))).toEqual(
        findBoundaries(text, rulesFor('es')),
      );
      expect(findBoundaries(text, resolveProfile('en'))).toEqual(
        findBoundaries(text, rulesFor('en')),
      );
    }
  });

  it('an added abbreviation stops a false break', () => {
    // The motivating case for the whole feature: a domain abbreviation
    // the built-in list cannot know.
    const text = 'La Bibl. Nacional abre hoy.';
    expect(split(text, resolveProfile('es'))).toHaveLength(2);
    const delta: ProfileDelta = {
      version: 1,
      lang: 'es',
      abbreviations: { added: ['Bibl'] },
    };
    expect(split(text, resolveProfile(delta))).toHaveLength(1);
  });

  it('a removal survives resolution against updated defaults', () => {
    const delta: ProfileDelta = {
      version: 1,
      lang: 'en',
      abbreviations: { removed: ['No'] },
    };
    const profile = resolveProfile(delta);
    expect(profile.abbreviations).not.toContain('No');
    expect(profile.abbreviations).toContain('Mr'); // rest untouched
  });

  it('refuses a delta applied to the wrong language', () => {
    const delta: ProfileDelta = { version: 1, lang: 'de' };
    expect(() => resolveProfile('es', delta)).toThrow(ProfileError);
  });

  it('resolves regional tags against the primary subtag', () => {
    const delta: ProfileDelta = {
      version: 1,
      lang: 'es-419',
      abbreviations: { added: ['Depto'] },
    };
    expect(resolveProfile('es-ES', delta).abbreviations).toContain('Depto');
  });
});

describe('ordinal followers (forward, the Trados model)', () => {
  it('stops a break before a month with no determiner', () => {
    // Backward prefix matching cannot catch this: nothing before "30."
    // is a determiner. Forward follower matching is what Trados uses.
    const text = 'Frist: 30. Juni 2026.';
    expect(split(text, rulesFor('de'))).toHaveLength(1);
  });

  it('still breaks when the following word is not a follower', () => {
    expect(split('Wir zählten 20. Dann gingen wir.', rulesFor('de'))).toHaveLength(2);
  });

  it('works in any language once added by delta', () => {
    const text = 'Véase el cap. 5. Enero trae cambios.';
    // Default: two sentences.
    expect(split(text, resolveProfile('es'))).toHaveLength(2);
    const delta: ProfileDelta = {
      version: 1,
      lang: 'es',
      ordinalFollowers: { added: ['Enero'] },
    };
    expect(split(text, resolveProfile(delta))).toHaveLength(1);
  });
});

describe('variables', () => {
  it('never breaks inside a variable', () => {
    const text = 'Instale Vers. 2.0 ahora mismo.';
    expect(split(text, resolveProfile('es'))).toHaveLength(2);
    const delta: ProfileDelta = {
      version: 1,
      lang: 'es',
      variables: { added: ['Vers. 2.0'] },
    };
    expect(split(text, resolveProfile(delta))).toHaveLength(1);
  });
});

describe('user rules', () => {
  it('a no-break rule suppresses a built-in break', () => {
    const delta: ProfileDelta = {
      version: 1,
      lang: 'es',
      userRules: [{ break: false, beforeBreak: '\\bBibl\\.', afterBreak: '\\s' }],
    };
    expect(split('La Bibl. Nacional abre hoy.', resolveProfile(delta))).toHaveLength(1);
  });

  it('a break rule overrides a deliberate built-in bias', () => {
    // The engine deliberately does not break after "etc." — but a user
    // who wants that break must win, or custom rules are not custom.
    const delta: ProfileDelta = {
      version: 1,
      lang: 'en',
      userRules: [{ break: true, beforeBreak: '\\betc\\.', afterBreak: '\\s+[A-Z]' }],
    };
    expect(
      split('Bring pens, paper, etc. Then we begin.', resolveProfile(delta)),
    ).toHaveLength(2);
  });

  it('creates breaks at positions no terminator scan would visit', () => {
    const delta: ProfileDelta = {
      version: 1,
      lang: 'en',
      userRules: [{ break: true, beforeBreak: '•', afterBreak: '' }],
    };
    expect(split('One • Two • Three', resolveProfile(delta))).toHaveLength(3);
  });

  it('first match wins across ordered rules', () => {
    const noBreakFirst: ProfileDelta = {
      version: 1,
      lang: 'en',
      userRules: [
        { break: false, beforeBreak: 'X\\.', afterBreak: '\\s' },
        { break: true, beforeBreak: 'X\\.', afterBreak: '\\s' },
      ],
    };
    const breakFirst: ProfileDelta = {
      version: 1,
      lang: 'en',
      userRules: [...noBreakFirst.userRules!].reverse(),
    };
    const text = 'Section X. Applies now.';
    expect(split(text, resolveProfile(noBreakFirst))).toHaveLength(1);
    expect(split(text, resolveProfile(breakFirst))).toHaveLength(2);
  });

  it('reports rules that do not compile', () => {
    const problems = ruleProblems([
      { break: true, beforeBreak: '[', afterBreak: '' },
      { break: false, beforeBreak: 'fine', afterBreak: 'also fine' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('rule 1');
  });
});

describe('delta serialization for .ctm', () => {
  it('round-trips', () => {
    const delta: ProfileDelta = {
      version: 1,
      lang: 'es',
      abbreviations: { added: ['Bibl'], removed: ['P'] },
      userRules: [{ break: false, beforeBreak: 'a\\.', afterBreak: '\\s', note: 'x' }],
      breakOnColon: true,
    };
    expect(parseProfileDelta(serializeProfileDelta(delta))).toEqual(delta);
  });

  it('refuses malformed input loudly', () => {
    expect(() => parseProfileDelta('not json')).toThrow(ProfileError);
    expect(() => parseProfileDelta('{"version":2,"lang":"es"}')).toThrow(/version/);
    expect(() => parseProfileDelta('{"version":1}')).toThrow(/language/);
    expect(() =>
      parseProfileDelta('{"version":1,"lang":"es","abbreviations":{"added":[1]}}'),
    ).toThrow(/array of strings/);
    expect(() =>
      parseProfileDelta('{"version":1,"lang":"es","userRules":[{"break":"yes"}]}'),
    ).toThrow(/boolean/);
  });
});

describe('Trados resource lists', () => {
  it('parses BOM, CRLF and blank lines', () => {
    const text = '﻿Sr.\r\n\r\n  Bibl.  \r\nSr.\r\n';
    expect(parseResourceList(text, 'abbreviations')).toEqual(['Sr', 'Bibl']);
  });

  it('serialises abbreviations with the trailing period Trados expects', () => {
    expect(serializeResourceList(['Sr', 'Bibl'], 'abbreviations')).toBe(
      'Sr.\r\nBibl.\r\n',
    );
    expect(serializeResourceList(['Acme 3000'], 'variables')).toBe('Acme 3000\r\n');
  });

  it('imports into a minimal delta', () => {
    // 'Sr' is already a built-in Spanish abbreviation; only 'Bibl' should
    // land in the stored delta.
    const start: ProfileDelta = { version: 1, lang: 'es' };
    const delta = importResourceList(start, 'abbreviations', 'Sr.\r\nBibl.\r\n');
    expect(delta.abbreviations?.added).toEqual(['Bibl']);
    expect(delta.abbreviations?.removed).toBeUndefined();
  });

  it('re-importing an item the user removed un-removes it', () => {
    const start: ProfileDelta = {
      version: 1,
      lang: 'en',
      abbreviations: { removed: ['No'] },
    };
    const delta = importResourceList(start, 'abbreviations', 'No.\r\n');
    expect(resolveProfile(delta).abbreviations).toContain('No');
    expect(delta.abbreviations?.added ?? []).not.toContain('No');
  });

  it('round-trips a profile list', () => {
    const profile = resolveProfile({
      version: 1,
      lang: 'es',
      variables: { added: ['Acme 3000', 'Vers. 2.0'] },
    });
    const text = exportResourceList(profile, 'variables');
    expect(parseResourceList(text, 'variables')).toEqual(['Acme 3000', 'Vers. 2.0']);
  });
});

describe('SRX', () => {
  const customized = (): ProfileDelta => ({
    version: 1,
    lang: 'es',
    abbreviations: { added: ['Bibl'] },
    ordinalFollowers: { added: ['Enero'] },
    userRules: [{ break: false, beforeBreak: '\\bq\\.e\\.p\\.d\\.', afterBreak: '\\s' }],
  });

  it('exports a well-formed SRX 2.0 document', () => {
    const xml = exportSrx([resolveProfile(customized())]);
    expect(xml).toContain('<srx xmlns="http://www.lisa.org/srx20" version="2.0">');
    expect(xml).toContain('languagerulename="es"');
    expect(xml).toContain('<beforebreak>\\bBibl\\.</beforebreak>');
    // User rules come first: they outrank everything at home, and SRX is
    // first-match-wins abroad.
    expect(xml.indexOf('q\\.e\\.p\\.d')).toBeLessThan(xml.indexOf('\\bBibl\\.'));
  });

  it('re-imports its own export with the lists lifted and minimal', () => {
    const xml = exportSrx([resolveProfile(customized())]);
    const result = importSrx(xml);
    expect(result.problems).toEqual([]);
    const es = result.deltas.find((d) => d.lang === 'es')!;
    // The user's no-break rule for "q.e.p.d." is structurally identical
    // to a generated abbreviation guard, so import normalises it into the
    // abbreviation list. Behaviour is unchanged — the dotted-form matcher
    // covers it — and a list entry is more editable than a regex.
    expect(es.abbreviations?.added).toEqual(['q.e.p.d', 'Bibl']);
    expect(es.ordinalFollowers?.added).toEqual(['Enero']);
    expect(es.userRules ?? []).toHaveLength(0);
  });

  it('an imported profile still segments correctly', () => {
    const xml = exportSrx([resolveProfile(customized())]);
    const es = importSrx(xml).deltas.find((d) => d.lang === 'es')!;
    const profile = resolveProfile(es);
    expect(split('La Bibl. Nacional abre hoy.', profile)).toHaveLength(1);
    expect(split('Está aquí. ¿Dónde vamos?', profile)).toHaveLength(2);
  });

  it('accepts SRX 1.0 as memoQ emits it', () => {
    const memoq =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<srx xmlns="http://www.lisa.org/srx10" version="1.0">\n' +
      '<header segmentsubflows="yes"/>\n' +
      '<body><languagerules>\n' +
      '<languagerule languagerulename="Spanish">\n' +
      '<rule break="no"><beforebreak>\\bUd\\.</beforebreak>' +
      '<afterbreak>\\s</afterbreak></rule>\n' +
      '<rule break="yes"><beforebreak>[\\.\\?!]+</beforebreak>' +
      '<afterbreak>\\s</afterbreak></rule>\n' +
      '</languagerule>\n' +
      '</languagerules><maprules>\n' +
      '<languagemap languagepattern="es.*" languagerulename="Spanish"/>\n' +
      '</maprules></body></srx>';
    const result = importSrx(memoq);
    const es = result.deltas.find((d) => d.lang === 'es')!;
    expect(es).toBeDefined();
    // "Ud" is already a built-in Spanish abbreviation → lifted, minimal.
    expect(es.abbreviations?.added ?? []).not.toContain('Ud');
    expect(es.userRules?.some((r) => r.break)).toBe(true);
  });

  it('reports an unportable regex instead of dropping it silently', () => {
    const bad =
      '<srx version="2.0"><body><languagerules>' +
      '<languagerule languagerulename="en">' +
      '<rule break="yes"><beforebreak>[</beforebreak>' +
      '<afterbreak></afterbreak></rule>' +
      '</languagerule></languagerules>' +
      '<maprules><languagemap languagepattern="en.*" languagerulename="en"/>' +
      '</maprules></body></srx>';
    const result = importSrx(bad);
    expect(result.problems.some((p) => p.includes('not portable'))).toBe(true);
    const en = result.deltas.find((d) => d.lang === 'en');
    expect(en?.userRules ?? []).toHaveLength(0);
  });

  it('preserves a user rule whose patterns are not literal', () => {
    // \s is a character class, not an escaped literal: the rule must come
    // back as a rule, not be mangled into a bogus variable "Fig.s".
    const rule = { break: false, beforeBreak: 'Fig\\.', afterBreak: '\\s' };
    const profile = resolveProfile({ version: 1, lang: 'en', userRules: [rule] });
    const result = importSrx(exportSrx([profile]));
    expect(result.problems).toEqual([]);
    const en = result.deltas.find((d) => d.lang === 'en')!;
    expect(en.userRules).toEqual([rule]);
    expect(en.variables).toBeUndefined();
  });

  it('roundtrips a variable with a non-period terminator', () => {
    const profile = resolveProfile({
      version: 1,
      lang: 'en',
      variables: { added: ['Yahoo! Japan'] },
    });
    // The engine vetoes the break inside the variable…
    expect(split('We met Yahoo! Japan today.', profile)).toHaveLength(1);
    // …so the export must carry it, not silently drop it.
    const result = importSrx(exportSrx([profile]));
    expect(result.problems).toEqual([]);
    const en = result.deltas.find((d) => d.lang === 'en')!;
    expect(en.variables?.added).toEqual(['Yahoo! Japan']);
  });

  it('maps full-locale languagepatterns onto the primary subtag', () => {
    // Real SRX files target document locale tags ("en-US", "en[-_].*"),
    // which never literally match a bare primary subtag.
    for (const pattern of ['en-US', 'en[-_].*']) {
      const xml =
        '<srx version="2.0"><body><languagerules>' +
        '<languagerule languagerulename="Group1">' +
        '<rule break="no"><beforebreak>\\bfoo\\.</beforebreak>' +
        '<afterbreak>\\s</afterbreak></rule>' +
        '</languagerule></languagerules>' +
        `<maprules><languagemap languagepattern="${pattern}"` +
        ' languagerulename="Group1"/>' +
        '</maprules></body></srx>';
      const result = importSrx(xml);
      expect(result.problems).toEqual([]);
      const en = result.deltas.find((d) => d.lang === 'en');
      expect(en?.userRules).toHaveLength(1);
    }
  });

  it('skips an unmapped language group with a report', () => {
    const xml =
      '<srx version="2.0"><body><languagerules>' +
      '<languagerule languagerulename="Klingon"><rule break="yes">' +
      '<beforebreak>\\.</beforebreak><afterbreak>\\s</afterbreak></rule>' +
      '</languagerule></languagerules><maprules/></body></srx>';
    const result = importSrx(xml);
    expect(result.deltas).toHaveLength(0);
    expect(result.problems.some((p) => p.includes('Klingon'))).toBe(true);
  });
});

describe('defaultProfile', () => {
  it('mirrors the built-in rules with empty extensions', () => {
    const profile = defaultProfile('de');
    expect(profile.abbreviations).toEqual(rulesFor('de').abbreviations);
    expect(profile.ordinalFollowers).toContain('Januar');
    expect(profile.variables).toEqual([]);
    expect(profile.userRules).toEqual([]);
  });
});

describe('mergeListIntoDelta', () => {
  it('drops the field entirely when nothing changes', () => {
    const delta = mergeListIntoDelta(
      { version: 1, lang: 'es' },
      'abbreviations',
      ['Sr'], // already built in
    );
    expect(delta.abbreviations).toBeUndefined();
  });

  it('un-removing an item the base no longer supplies adds it instead', () => {
    // A stale removal — the built-in list changed underneath it — must
    // not swallow the item the caller asked to add.
    const delta = mergeListIntoDelta(
      { version: 1, lang: 'en', variables: { removed: ['Ghost'] } },
      'variables',
      ['Ghost'],
    );
    expect(resolveProfile('en', delta).variables).toContain('Ghost');
    expect(delta.variables?.removed).toBeUndefined();
  });

  it('deduplicates repeats within the merged items', () => {
    const delta = mergeListIntoDelta({ version: 1, lang: 'en' }, 'variables', [
      'Foo',
      'Foo',
    ]);
    expect(delta.variables?.added).toEqual(['Foo']);
  });
});
