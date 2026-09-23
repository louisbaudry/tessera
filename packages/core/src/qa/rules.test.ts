import { describe, expect, it } from 'vitest';

import type { Token } from '../model/token.js';
import { QA_CHECKS, runQaChecks, type QaCheckContext } from './rules.js';

const text = (v: string): Token => ({ t: 'text', v });
const open = (id: number): Token => ({ t: 'open', id, fmt: 0 });
const close = (id: number): Token => ({ t: 'close', id });
const ph = (id: number): Token => ({ t: 'ph', id, fmt: 0 });

const ALL_RULES = new Set(Object.keys(QA_CHECKS) as (keyof typeof QA_CHECKS)[]);

describe('checkTagMissing (tag.missing)', () => {
  it('does not fire with no target', () => {
    const ctx: QaCheckContext = { source: [open(1), text('a'), close(1)], target: null };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire when target carries every source tag', () => {
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1)],
      target: [open(1), text('b'), close(1)],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('fires once, naming every missing id, not once per id', () => {
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1), ph(2)],
      target: [text('b')],
    };
    const findings = runQaChecks(ctx, ALL_RULES);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      rule: 'tag.missing',
      severity: 'error',
      message: 'Missing tags: 1, 2',
    });
  });

  it('is silent when disabled even though the target is missing a tag', () => {
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1)],
      target: [text('a')],
    };
    expect(runQaChecks(ctx, new Set())).toEqual([]);
  });
});

describe('checkTagExtra (tag.extra)', () => {
  it('fires when the target adds a tag the source never had', () => {
    const ctx: QaCheckContext = {
      source: [text('a')],
      target: [open(1), text('b'), close(1)],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([
      { rule: 'tag.extra', severity: 'error', message: 'Extra tag: 1' },
    ]);
  });

  it('does not fire on a plain, tag-free round trip', () => {
    const ctx: QaCheckContext = { source: [text('a')], target: [text('b')] };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });
});

describe('checkTagUnbalanced (tag.unbalanced)', () => {
  it('does not fire on a well-formed target', () => {
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1)],
      target: [open(1), text('b'), close(1)],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('fires on an unclosed tag, isolated from tag.missing/tag.extra by matching source and target signatures', () => {
    // Source has tag 1, closed; target opens the same id but never closes
    // it. `tagSignature` only counts opens, so the two signatures still
    // match — this is purely a structural break, not a missing/extra tag.
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1)],
      target: [open(1), text('b')],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([
      { rule: 'tag.unbalanced', severity: 'error', message: 'tag 1 never closed' },
    ]);
  });

  it('fires on interleaved pairs, describing which tag crosses which', () => {
    // Source opens and closes both ids in order, so signatures match and
    // only the target's interleaving — <1>a<2>b</1>c</2> — is at fault.
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1), open(2), text('b'), close(2)],
      target: [open(1), text('a'), open(2), text('b'), close(1), text('c'), close(2)],
    };
    const findings = runQaChecks(ctx, ALL_RULES);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('closes across tag');
  });

  it('never inspects source structure \u2014 only target', () => {
    // A deliberately broken "source" (never happens in practice — assembleFile
    // guarantees valid source structure) must not itself trigger the rule
    // when the target is fine.
    const ctx: QaCheckContext = {
      source: [open(1), text('a')],
      target: [open(1), text('b'), close(1)],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });
});

describe('runQaChecks', () => {
  it('runs every enabled rule and concatenates their findings', () => {
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1)],
      target: [open(2), text('b')],
    };
    const findings = runQaChecks(ctx, ALL_RULES);
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toEqual(['tag.extra', 'tag.missing', 'tag.unbalanced']);
  });

  it('skips a rule present in QA_CHECKS but absent from enabledRules', () => {
    const ctx: QaCheckContext = {
      source: [open(1), text('a'), close(1)],
      target: [text('b')],
    };
    const findings = runQaChecks(ctx, new Set(['tag.extra']));
    expect(findings).toEqual([]);
  });
});

describe('checkSegEmpty (seg.empty)', () => {
  it('fires when a translated segment has no target', () => {
    const ctx: QaCheckContext = {
      source: [text('hello')],
      target: null,
      status: 'translated',
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([
      { rule: 'seg.empty', severity: 'error', message: 'Target is empty' },
    ]);
  });

  it('fires when a confirmed segment has a blank (whitespace-only) target', () => {
    const ctx: QaCheckContext = {
      source: [text('hello')],
      target: [text('   ')],
      status: 'confirmed',
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([
      { rule: 'seg.empty', severity: 'error', message: 'Target is empty' },
    ]);
  });

  it('does not fire on a new/draft segment with no target \u2014 not yet due', () => {
    const ctx: QaCheckContext = { source: [text('hello')], target: null, status: 'new' };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire on a locked segment with no target \u2014 deliberately untranslatable', () => {
    const ctx: QaCheckContext = {
      source: [text('hello')],
      target: null,
      status: 'locked',
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire when status is omitted from the context', () => {
    const ctx: QaCheckContext = { source: [text('hello')], target: null };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire when the target has text', () => {
    const ctx: QaCheckContext = {
      source: [text('hello')],
      target: [text('bonjour')],
      status: 'confirmed',
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });
});

describe('checkSegUntranslated (seg.untranslated)', () => {
  it('fires when the target is identical to the source', () => {
    const ctx: QaCheckContext = {
      source: [text('Hello world')],
      target: [text('Hello world')],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([
      {
        rule: 'seg.untranslated',
        severity: 'warning',
        message: 'Target is identical to source',
      },
    ]);
  });

  it('does not fire with no target \u2014 that is seg.empty', () => {
    const ctx: QaCheckContext = { source: [text('Hello world')], target: null };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire when the source has no letters (numbers/punctuation only)', () => {
    const ctx: QaCheckContext = {
      source: [text('12,345.00 \u2014 \u20AC')],
      target: [text('12,345.00 \u2014 \u20AC')],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire when suppressed by the per-project allow-list', () => {
    const ctx: QaCheckContext = {
      source: [text('Acme Corp')],
      target: [text('Acme Corp')],
      untranslatedAllowed: true,
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire when target differs from source', () => {
    const ctx: QaCheckContext = {
      source: [text('Hello world')],
      target: [text('Bonjour le monde')],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });
});

describe('checkConsistencyTargetDiffers (consistency.target_differs)', () => {
  it('fires naming other renderings of the same source', () => {
    const ctx: QaCheckContext = {
      source: [text('Click here')],
      target: [text('Cliquez ici')],
      siblings: {
        sameSourceOtherTargets: ['Cliquez l\u00E0'],
        sameTargetOtherSources: [],
      },
    };
    const findings = runQaChecks(ctx, ALL_RULES);
    expect(findings).toEqual([
      {
        rule: 'consistency.target_differs',
        severity: 'warning',
        message: 'Same source translated differently elsewhere: Cliquez l\u00E0',
      },
    ]);
  });

  it('does not fire when every sibling rendering matches this one', () => {
    const ctx: QaCheckContext = {
      source: [text('Click here')],
      target: [text('Cliquez ici')],
      siblings: { sameSourceOtherTargets: ['Cliquez ici'], sameTargetOtherSources: [] },
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });

  it('does not fire when siblings is omitted (no project context)', () => {
    const ctx: QaCheckContext = {
      source: [text('Click here')],
      target: [text('Cliquez ici')],
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });
});

describe('checkConsistencySourceDiffers (consistency.source_differs)', () => {
  it('fires naming the other source that shares this rendering', () => {
    const ctx: QaCheckContext = {
      source: [text('Submit')],
      target: [text('Envoyer')],
      siblings: { sameSourceOtherTargets: [], sameTargetOtherSources: ['Send'] },
    };
    const findings = runQaChecks(ctx, ALL_RULES);
    expect(findings).toEqual([
      {
        rule: 'consistency.source_differs',
        severity: 'info',
        message: 'Same rendering used for a different source elsewhere: Send',
      },
    ]);
  });

  it('does not fire when no other source shares this rendering', () => {
    const ctx: QaCheckContext = {
      source: [text('Submit')],
      target: [text('Envoyer')],
      siblings: { sameSourceOtherTargets: [], sameTargetOtherSources: [] },
    };
    expect(runQaChecks(ctx, ALL_RULES)).toEqual([]);
  });
});

/** A bare source/target pair with optional project languages. */
const pair = (
  source: string,
  target: string | null,
  langs?: { readonly src: string; readonly tgt: string },
): QaCheckContext => ({
  source: [text(source)],
  target: target === null ? null : [text(target)],
  ...(langs ? { srcLang: langs.src, tgtLang: langs.tgt } : {}),
});

const only = (ctx: QaCheckContext, rule: keyof typeof QA_CHECKS) =>
  runQaChecks(ctx, new Set([rule]));

const EN_FR_LANGS = { srcLang: 'en', tgtLang: 'fr' } as const;

describe('checkNumMissing / checkNumAltered (num.*)', () => {
  const EN_FR = { src: 'en', tgt: 'fr' };
  const EN_EN = { src: 'en-GB', tgt: 'en-US' };

  it('report nothing without project languages \u2014 no locale, no claim', () => {
    const ctx = pair('Pay 1,000.50 now', 'Nothing here');
    expect(only(ctx, 'num.missing')).toEqual([]);
    expect(only(ctx, 'num.altered')).toEqual([]);
  });

  it('report nothing with no target', () => {
    expect(only(pair('Pay 1,000.50', null, EN_FR), 'num.missing')).toEqual([]);
  });

  it('num.missing names every source number absent from the target', () => {
    const ctx = pair('Chapter 12 has 40 pages and 3 figures', 'Le chapitre 12', EN_FR);
    expect(only(ctx, 'num.missing')).toEqual([
      { rule: 'num.missing', severity: 'error', message: 'Missing numbers: 40, 3' },
    ]);
    expect(only(ctx, 'num.altered')).toEqual([]);
  });

  it('num.altered fires on the spec example: 1,000 \u2192 1 000 in an English target', () => {
    const ctx = pair('Ship 1,000 units', 'Ship 1 000 units', EN_EN);
    expect(only(ctx, 'num.altered')).toEqual([
      {
        rule: 'num.altered',
        severity: 'warning',
        message: 'Number reformatted: 1,000 \u2192 1 000',
      },
    ]);
    expect(only(ctx, 'num.missing')).toEqual([]);
  });

  it('num.altered fires on a German-style thousands point in a French target', () => {
    // Spec-before-code decision (v1-spec.md §6.4): French groups with a
    // space, never a point, so `1.000` in French is not a localisation
    // of `1,000` — it reads as nothing at all under French conventions.
    const ctx = pair('1,000 units', '1.000 unit\u00E9s', EN_FR);
    expect(only(ctx, 'num.altered').map((f) => f.message)).toEqual([
      'Number reformatted: 1,000 \u2192 1.000',
    ]);
  });

  it('never fires on a number copied verbatim, whatever the target locale would write', () => {
    const ctx = pair('Version 3.5 of the API', "Version 3.5 de l'API", EN_FR);
    expect(only(ctx, 'num.missing')).toEqual([]);
    expect(only(ctx, 'num.altered')).toEqual([]);
  });

  it('sees through paired tags inside a number', () => {
    const ctx: QaCheckContext = {
      source: [text('1'), open(1), text(',000'), close(1), text(' units')],
      target: [text('1'), open(1), text('\u202F000'), close(1), text(' unit\u00E9s')],
      ...EN_FR_LANGS,
    };
    expect(only(ctx, 'num.missing')).toEqual([]);
    expect(only(ctx, 'num.altered')).toEqual([]);
  });

  it('treats a placeholder as a boundary, not glue', () => {
    // `Room 12<tab>34` is two numbers; a target `1234` would have merged them.
    const ctx: QaCheckContext = {
      source: [text('Room 12'), ph(1), text('34')],
      target: [text('Salle 1234')],
      ...EN_FR_LANGS,
    };
    expect(only(ctx, 'num.missing').map((f) => f.message)).toEqual([
      'Missing numbers: 12, 34',
    ]);
  });
});

describe('locale-correct translations raise zero num.*/punct.* issues (backlog #24 "done when")', () => {
  // Every invisible space below is an explicit escape (CLAUDE.md): a
  // narrow no-break space that arrived on disk as a plain space would
  // make the French cases pass for the wrong reason.
  const NNBSP = '\u202F';
  const NBSP = '\u00A0';
  const cases: readonly {
    readonly en: string;
    readonly fr: string;
    readonly de: string;
    readonly es: string;
  }[] = [
    {
      en: 'The invoice totals 1,234.56 EUR, due in 30 days.',
      fr: `La facture s\u2019\u00E9l\u00E8ve \u00E0 1${NNBSP}234,56 EUR, payable sous 30 jours.`,
      de: 'Die Rechnung bel\u00E4uft sich auf 1.234,56 EUR, f\u00E4llig in 30 Tagen.',
      es: 'La factura asciende a 1.234,56 EUR, pagadera en 30 d\u00EDas.',
    },
    {
      en: 'Revenue grew 12.5% to 2,000,000 units in 2024.',
      fr: `Le chiffre d\u2019affaires a progress\u00E9 de 12,5${NNBSP}% pour atteindre 2${NBSP}000${NBSP}000 unit\u00E9s en 2024.`,
      de: `Der Umsatz stieg 2024 um 12,5${NBSP}% auf 2.000.000 Einheiten.`,
      es: `Los ingresos crecieron un 12,5${NBSP}% hasta 2.000.000 de unidades en 2024.`,
    },
    {
      en: 'See section 3.2.1 (page 45) for details; version 2.0 applies.',
      fr: `Voir la section 3.2.1 (page 45) pour plus de d\u00E9tails${NNBSP}; la version 2.0 s\u2019applique.`,
      de: 'Siehe Abschnitt 3.2.1 (Seite 45) f\u00FCr Einzelheiten; es gilt Version 2.0.',
      es: 'Consulte la secci\u00F3n 3.2.1 (p\u00E1gina 45) para m\u00E1s detalles; se aplica la versi\u00F3n 2.0.',
    },
    {
      en: 'Is the meeting at 10:30 on 03/12/2025?',
      fr: `La r\u00E9union a-t-elle lieu \u00E0 10${NBSP}h${NBSP}30 le 12/03/2025${NNBSP}?`,
      de: 'Findet das Treffen am 12.03.2025 um 10:30 Uhr statt?',
      es: '\u00BFLa reuni\u00F3n es a las 10:30 el 12/03/2025?',
    },
    {
      en: 'He said "no" \u2014 twice!',
      fr: `Il a dit \u00AB${NNBSP}non${NNBSP}\u00BB \u2014 deux fois${NNBSP}!`,
      de: 'Er sagte \u201Enein\u201C \u2013 zweimal!',
      es: '\u00A1Dijo \u00ABno\u00BB dos veces!',
    },
    {
      en: 'Temperatures range from -5 to 1,050.5 degrees (see Table 4).',
      fr: `Les temp\u00E9ratures vont de -5 \u00E0 1${NNBSP}050,5 degr\u00E9s (voir le tableau 4).`,
      de: 'Die Temperaturen reichen von -5 bis 1.050,5 Grad (siehe Tabelle 4).',
      es: 'Las temperaturas oscilan entre -5 y 1.050,5 grados (v\u00E9ase la tabla 4).',
    },
    {
      en: 'Call 555 1234 or visit https://example.com/?id=42 today.',
      fr: 'Appelez le 555 1234 ou consultez https://example.com/?id=42 d\u00e8s aujourd\u2019hui.',
      de: 'Rufen Sie 555 1234 an oder besuchen Sie https://example.com/?id=42 noch heute.',
      es: 'Llame al 555 1234 o visite https://example.com/?id=42 hoy mismo.',
    },
  ];

  const NUM_PUNCT = new Set<keyof typeof QA_CHECKS>([
    'num.missing',
    'num.altered',
    'punct.terminal',
    'punct.brackets',
    'punct.inverted',
    'punct.spacing',
  ]);

  it.each(cases.map((c, i) => [i, c] as const))('EN \u2192 FR case %i', (_, c) => {
    expect(
      runQaChecks(pair(c.en, c.fr, { src: 'en-US', tgt: 'fr-FR' }), NUM_PUNCT),
    ).toEqual([]);
  });
  it.each(cases.map((c, i) => [i, c] as const))('EN \u2192 DE case %i', (_, c) => {
    expect(
      runQaChecks(pair(c.en, c.de, { src: 'en-US', tgt: 'de-DE' }), NUM_PUNCT),
    ).toEqual([]);
  });
  it.each(cases.map((c, i) => [i, c] as const))('EN \u2192 ES case %i', (_, c) => {
    expect(
      runQaChecks(pair(c.en, c.es, { src: 'en-US', tgt: 'es-ES' }), NUM_PUNCT),
    ).toEqual([]);
  });

  it('a Mexican Spanish target keeps English-style separators', () => {
    const ctx = pair('It costs 1,234.56 pesos.', 'Cuesta 1,234.56 pesos.', {
      src: 'en',
      tgt: 'es-MX',
    });
    expect(runQaChecks(ctx, NUM_PUNCT)).toEqual([]);
  });

  it('a Swiss German target groups with an apostrophe', () => {
    const ctx = pair('It costs 1,234.56 francs.', "Es kostet 1'234.56 Franken.", {
      src: 'en',
      tgt: 'de-CH',
    });
    expect(runQaChecks(ctx, NUM_PUNCT)).toEqual([]);
  });

  it('a time-format change is a known miss: "5 p.m." to "17 h" reads as a dropped 5', () => {
    // Recorded, not fixed: the rule cannot tell a 12-hour to 24-hour
    // conversion from a dropped number, and guessing would cost more
    // real findings than it saves. One dismissal per such segment.
    const ctx = pair('before 5 p.m.', 'avant 17 h.', { src: 'en', tgt: 'fr' });
    expect(only(ctx, 'num.missing').map((f) => f.message)).toEqual(['Missing number: 5']);
  });
});

describe('checkPunctTerminal (punct.terminal)', () => {
  it('fires when the source ends in a full stop and the target does not', () => {
    expect(only(pair('Hello world.', 'Bonjour le monde'), 'punct.terminal')).toEqual([
      {
        rule: 'punct.terminal',
        severity: 'warning',
        message: 'Source ends with "." but target does not',
      },
    ]);
  });

  it('fires the other way round too', () => {
    expect(only(pair('Hello world', 'Bonjour le monde ?'), 'punct.terminal')).toEqual([
      {
        rule: 'punct.terminal',
        severity: 'warning',
        message: 'Target ends with "?" but source does not',
      },
    ]);
  });

  it('checks presence only, not which mark', () => {
    expect(only(pair('Really?', 'Vraiment.'), 'punct.terminal')).toEqual([]);
  });

  it('looks past closing quotes, brackets and a trailing placeholder', () => {
    expect(
      only(
        pair('He said "Go."', 'Il a dit \u00AB\u202FVa.\u202F\u00BB'),
        'punct.terminal',
      ),
    ).toEqual([]);
    // German closes with the marks English opens with, and reverses its
    // guillemets; both are still "past" the full stop.
    expect(
      only(pair('He said "Go."', 'Er sagte: \u201EGeh.\u201C'), 'punct.terminal'),
    ).toEqual([]);
    expect(
      only(pair('He said "Go."', 'Er sagte: \u00BBGeh.\u00AB'), 'punct.terminal'),
    ).toEqual([]);
    const ctx: QaCheckContext = {
      source: [text('Hello.'), ph(1)],
      target: [text('Bonjour.'), ph(1)],
    };
    expect(only(ctx, 'punct.terminal')).toEqual([]);
  });

  it('treats an ellipsis as terminal', () => {
    expect(only(pair('Wait\u2026', 'Attends...'), 'punct.terminal')).toEqual([]);
  });

  it('is silent when neither side ends in a mark, or the target is blank', () => {
    expect(only(pair('Title', 'Titre'), 'punct.terminal')).toEqual([]);
    expect(only(pair('Title.', '   '), 'punct.terminal')).toEqual([]);
    expect(only(pair('Title.', null), 'punct.terminal')).toEqual([]);
  });
});

describe('checkPunctBrackets (punct.brackets)', () => {
  it('fires on an unclosed parenthesis the source did not have', () => {
    expect(only(pair('Text (note) here', 'Texte (note ici'), 'punct.brackets')).toEqual([
      {
        rule: 'punct.brackets',
        severity: 'error',
        message: 'Unbalanced: 1 \u00D7 (, 0 \u00D7 )',
      },
    ]);
  });

  it('fires on an odd number of straight quotes', () => {
    expect(
      only(pair('Say "hi" now', 'Dis "salut maintenant'), 'punct.brackets').map(
        (f) => f.message,
      ),
    ).toEqual(['Unbalanced: 1 \u00D7 "']);
  });

  it('is silent when the source carries the identical imbalance (a segment split mid-parenthesis)', () => {
    expect(only(pair('(see Figure 1.', '(voir la figure 1.'), 'punct.brackets')).toEqual(
      [],
    );
  });

  it('still fires when the imbalance differs from the source\u2019s', () => {
    expect(
      only(pair('(see Figure 1.', '((voir la figure 1.'), 'punct.brackets'),
    ).toHaveLength(1);
  });

  it('ignores a leading list enumerator', () => {
    expect(only(pair('Apples', 'a) Pommes'), 'punct.brackets')).toEqual([]);
    expect(only(pair('12) Apples', '12) Pommes'), 'punct.brackets')).toEqual([]);
  });

  it('accepts every language\u2019s curly-quote and guillemet convention', () => {
    for (const target of [
      '\u201CWord\u201D',
      '\u201EWort\u201C',
      '\u201EWoord\u201D',
      '\u00AB\u00A0mot\u00A0\u00BB',
      '\u00BBWort\u00AB',
    ]) {
      expect(only(pair('"Word"', target), 'punct.brackets')).toEqual([]);
    }
  });

  it('reports every unbalanced family in one finding', () => {
    const findings = only(pair('a (b) [c]', 'a (b [c'), 'punct.brackets');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe(
      'Unbalanced: 1 \u00D7 (, 0 \u00D7 ); 1 \u00D7 [, 0 \u00D7 ]',
    );
  });
});

describe('checkPunctInverted (punct.inverted)', () => {
  const ES = { src: 'en', tgt: 'es-ES' };

  it('fires on a closing ? with no opening \u00BF', () => {
    expect(
      only(pair('How are you?', 'C\u00F3mo est\u00E1s?', ES), 'punct.inverted'),
    ).toEqual([
      { rule: 'punct.inverted', severity: 'error', message: '? without \u00BF' },
    ]);
  });

  it('fires on a closing ! with no opening \u00A1, naming both when both are missing', () => {
    expect(
      only(pair('Hi! Ready?', 'Hola! Listo?', ES), 'punct.inverted').map(
        (f) => f.message,
      ),
    ).toEqual(['? without \u00BF; ! without \u00A1']);
  });

  it('is silent when every closing run has an opening run', () => {
    for (const target of [
      '\u00BFC\u00F3mo est\u00E1s?',
      '\u00A1Hola!!!',
      '\u00A1\u00BFQu\u00E9?!',
      '\u00BFQu\u00E9? \u00BFC\u00F3mo?',
      'Sin marcas.',
    ]) {
      expect(only(pair('x', target, ES), 'punct.inverted')).toEqual([]);
    }
  });

  it('never fires for a non-Spanish target, or with no target language', () => {
    expect(
      only(pair('How?', 'Comment?', { src: 'en', tgt: 'fr' }), 'punct.inverted'),
    ).toEqual([]);
    expect(only(pair('How?', 'C\u00F3mo?'), 'punct.inverted')).toEqual([]);
  });
});

describe('checkPunctSpacing (punct.spacing)', () => {
  const EN = { src: 'fr', tgt: 'en' };
  const FR = { src: 'en', tgt: 'fr-FR' };

  it('fires on a double space, in any language', () => {
    expect(only(pair('a b', 'a  b'), 'punct.spacing')).toEqual([
      { rule: 'punct.spacing', severity: 'warning', message: 'double space' },
    ]);
    expect(
      only(pair('a b', 'a\u00A0 b', FR), 'punct.spacing').map((f) => f.message),
    ).toEqual(['double space']);
  });

  it('fires on a space before a comma or full stop, in any language', () => {
    expect(
      only(pair('a, b.', 'a , b .', FR), 'punct.spacing').map((f) => f.message),
    ).toEqual(['space before ","; space before "."']);
  });

  it('lets a spaced ellipsis through', () => {
    expect(only(pair('Well ...', 'Eh bien ...', FR), 'punct.spacing')).toEqual([]);
  });

  it('fires on a space before ; or : outside French \u2014 including one inherited from a French source', () => {
    expect(
      only(pair('Note\u00A0: ceci', 'Note : this', EN), 'punct.spacing').map(
        (f) => f.message,
      ),
    ).toEqual(['space before ":"']);
  });

  it('does not judge ; or : with no target language to say which way', () => {
    expect(only(pair('Note: this', 'Note : ceci'), 'punct.spacing')).toEqual([]);
  });

  it('French: a no-break space before ; : ! ? and inside guillemets is correct', () => {
    for (const target of [
      'Note\u00A0: ceci\u202F; cela\u202F! Vraiment\u202F?',
      '\u00AB\u202FBonjour\u202F\u00BB',
      'Ouvert de 10:30 \u00E0 12:00',
      'Voir https://example.com/?id=3',
      'Ah bon\u2026\u202F?!',
    ]) {
      expect(only(pair('x', target, FR), 'punct.spacing')).toEqual([]);
    }
  });

  it('French: a plain space, or no space, before those marks is reported', () => {
    expect(
      only(pair('x', 'Note : ceci; cela!', FR), 'punct.spacing').map((f) => f.message),
    ).toEqual([
      'plain space before ":" (expected a no-break space); no space before ";" (expected a no-break space); no space before "!" (expected a no-break space)',
    ]);
    expect(
      only(pair('x', '\u00ABBonjour \u00BB', FR), 'punct.spacing').map((f) => f.message),
    ).toEqual([
      'no space after "\u00AB" (expected a no-break space); plain space before "\u00BB" (expected a no-break space)',
    ]);
  });

  it('Qu\u00E9bec French wants the space before : only; Swiss French none', () => {
    const CA = { src: 'en', tgt: 'fr-CA' };
    const CH = { src: 'en', tgt: 'fr-CH' };
    expect(only(pair('x', 'Note\u00A0: ceci; cela!', CA), 'punct.spacing')).toEqual([]);
    expect(only(pair('x', 'Note: ceci', CA), 'punct.spacing')).toHaveLength(1);
    expect(only(pair('x', 'Note: ceci; cela!', CH), 'punct.spacing')).toEqual([]);
  });

  it('a placeholder between two spaces is not a double space', () => {
    const ctx: QaCheckContext = {
      source: [text('a '), ph(1), text(' b')],
      target: [text('a '), ph(1), text(' b')],
    };
    expect(only(ctx, 'punct.spacing')).toEqual([]);
  });

  it('is silent on a blank target \u2014 that is seg.empty', () => {
    expect(only(pair('a', '   '), 'punct.spacing')).toEqual([]);
  });
});

describe('checkPunctInverted ignores marks inside tokens', () => {
  it('does not count the ? of a URL query string', () => {
    const ctx = pair('See https://example.com/?id=42', 'Vea https://example.com/?id=42', {
      src: 'en',
      tgt: 'es',
    });
    expect(only(ctx, 'punct.inverted')).toEqual([]);
  });
});
