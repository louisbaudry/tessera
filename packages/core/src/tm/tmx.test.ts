import { describe, expect, it } from 'vitest';

import type { TmToken } from '../model/token.js';
import {
  isoToTmxDate,
  parseTmx,
  serializeTmx,
  tmxDateToIso,
  TmxError,
  TmxStreamParser,
  type ParsedTmxTu,
  type TmxExportDoc,
  type TmxExportTu,
  type TmxExportTuv,
} from './tmx.js';

/** A minimal but structurally realistic TMX 1.4b document, Trados-shaped. */
function tmx(
  bodyInner: string,
  header = '<header srclang="en" adminlang="en" o-tmf="TW4" datatype="plaintext" segtype="sentence"/>',
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
${header}
<body>
${bodyInner}
</body>
</tmx>`;
}

describe('parseTmx', () => {
  it('parses a bilingual unit into one ParsedTmxTu per <tu>, one variant per <tuv>', () => {
    const parsed = parseTmx(
      tmx(`
<tu tuid="1" creationdate="20260101T120000Z" creationid="alice">
  <tuv xml:lang="en"><seg>Hello world</seg></tuv>
  <tuv xml:lang="es"><seg>Hola mundo</seg></tuv>
</tu>`),
    );
    expect(parsed.units).toHaveLength(1);
    const [tu] = parsed.units;
    expect(tu!.tuid).toBe('1');
    expect(tu!.creationid).toBe('alice');
    expect(tu!.variants).toHaveLength(2);
    expect(tu!.variants[0]).toMatchObject({
      lang: 'en',
      tokens: [{ t: 'text', v: 'Hello world' }],
    });
    expect(tu!.variants[1]).toMatchObject({
      lang: 'es',
      tokens: [{ t: 'text', v: 'Hola mundo' }],
    });
  });

  it('imports a multilingual TMX whole — every <tuv> becomes a variant, not flattened to a pair', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en"><seg>Save</seg></tuv>
  <tuv xml:lang="es"><seg>Guardar</seg></tuv>
  <tuv xml:lang="de"><seg>Speichern</seg></tuv>
  <tuv xml:lang="fr"><seg>Enregistrer</seg></tuv>
</tu>`),
    );
    expect(parsed.units[0]!.variants.map((v) => v.lang)).toEqual([
      'en',
      'es',
      'de',
      'fr',
    ]);
  });

  it('pairs <bpt>/<ept> by their TMX i attribute into open/close, and maps <ph>/<it> to ph', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en"><seg>Click <bpt i="1">&lt;b&gt;</bpt>here<ept i="1">&lt;/b&gt;</ept> or <ph x="2"/> to continue<it pos="begin"/></seg></tuv>
</tu>`),
    );
    const tokens = parsed.units[0]!.variants[0]!.tokens;
    expect(tokens).toEqual([
      { t: 'text', v: 'Click ' },
      { t: 'open', id: 1, k: undefined },
      { t: 'text', v: 'here' },
      { t: 'close', id: 1 },
      { t: 'text', v: ' or ' },
      { t: 'ph', id: 2, k: undefined },
      { t: 'text', v: ' to continue' },
      { t: 'ph', id: 3, k: undefined },
    ]);
  });

  it('recognises a type= matching one of our own TagKind names as a k hint (our own export roundtripping)', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en"><seg><bpt i="1" type="b">&lt;b&gt;</bpt>bold<ept i="1">&lt;/b&gt;</ept></seg></tuv>
</tu>`),
    );
    const tokens = parsed.units[0]!.variants[0]!.tokens;
    expect(tokens[0]).toEqual({ t: 'open', id: 1, k: 'b' });
  });

  it('leaves an unrecognised type= as an unhinted tag rather than guessing', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en"><seg><ph type="something-tool-specific"/>x</seg></tuv>
</tu>`),
    );
    expect(parsed.units[0]!.variants[0]!.tokens[0]).toEqual({
      t: 'ph',
      id: 1,
      k: undefined,
    });
  });

  it('pairs nested <hi> highlights via their own stack, preserving inner text', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en"><seg>a<hi>b<hi>c</hi>d</hi>e</seg></tuv>
</tu>`),
    );
    const tokens = parsed.units[0]!.variants[0]!.tokens;
    expect(tokens.map((t) => t.t)).toEqual([
      'text',
      'open',
      'text',
      'open',
      'text',
      'close',
      'text',
      'close',
      'text',
    ]);
    expect(tokens.map((t) => (t.t === 'text' ? t.v : null))).toEqual([
      'a',
      null,
      'b',
      null,
      'c',
      null,
      'd',
      null,
      'e',
    ]);
  });

  it('degrades an unknown inline element to a bare ph placeholder rather than dropping it', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en"><seg>before<sub>x</sub>after</seg></tuv>
</tu>`),
    );
    const tokens = parsed.units[0]!.variants[0]!.tokens;
    // The unknown element's own text ("x") is not separately preserved —
    // "degrade to ph" per tm-format-spec.md §8, not "recurse and keep text".
    expect(tokens).toEqual([
      { t: 'text', v: 'before' },
      { t: 'ph', id: 1 },
      { t: 'text', v: 'after' },
    ]);
  });

  it('throws on an <ept> with no matching <bpt> — a real structural problem, not a warning', () => {
    expect(() =>
      parseTmx(
        tmx(`
<tu>
  <tuv xml:lang="en"><seg>broken<ept i="9"/></seg></tuv>
</tu>`),
      ),
    ).toThrow(TmxError);
  });

  it('throws when the root element is not <tmx>', () => {
    expect(() => parseTmx('<notTmx></notTmx>')).toThrow(TmxError);
  });

  it('throws on a <tu> with no <tuv> at all', () => {
    expect(() => parseTmx(tmx('<tu tuid="empty"></tu>'))).toThrow(TmxError);
  });

  it('maps <prop type="x"> to a unit-level prop, and <note> to the reserved "note" key', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <prop type="x-context">clicking Save</prop>
  <note>flagged for review</note>
  <tuv xml:lang="en"><seg>Save</seg></tuv>
</tu>`),
    );
    const props = parsed.units[0]!.props;
    expect(props).toContainEqual({ type: 'x-context', value: 'clicking Save' });
    expect(props).toContainEqual({ type: 'note', value: 'flagged for review' });
  });

  it('maps a recognised x-* prop onto its reserved tu_attr key', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <prop type="x-Client">Acme</prop>
  <tuv xml:lang="en"><seg>Save</seg></tuv>
</tu>`),
    );
    expect(parsed.units[0]!.props).toContainEqual({ type: 'client', value: 'Acme' });
  });

  it('warns rather than silently dropping data when a <tu> repeats the same prop type, aggregated across the whole document', () => {
    // Real Trados/SDL exports do this routinely for x-Context bookkeeping
    // — sometimes 100+ times on one unit, and across thousands of units
    // in one file — so this is one summary line, not one per occurrence.
    const parsed = parseTmx(
      tmx(`
<tu>
  <prop type="x-Context">a, a</prop>
  <prop type="x-Context">b, b</prop>
  <prop type="x-Context">c, c</prop>
  <tuv xml:lang="en"><seg>Save</seg></tuv>
</tu>
<tu>
  <prop type="x-Context">d, d</prop>
  <prop type="x-Context">e, e</prop>
  <tuv xml:lang="en"><seg>Cancel</seg></tuv>
</tu>`),
    );
    const contextWarnings = parsed.warnings.filter((w) => w.includes('x-Context'));
    expect(contextWarnings).toHaveLength(1);
    expect(contextWarnings[0]).toContain('2 unit(s)/variant(s)');
    // Last value wins — deterministic, just no longer silent.
    expect(parsed.units[0]!.props).toContainEqual({ type: 'x-Context', value: 'c, c' });
    expect(parsed.units[1]!.props).toContainEqual({ type: 'x-Context', value: 'e, e' });
  });

  it('warns rather than silently dropping data when a <tuv> repeats the same prop type', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en">
    <prop type="x-catm-quality">1</prop>
    <prop type="x-catm-quality">2</prop>
    <seg>Save</seg>
  </tuv>
</tu>`),
    );
    expect(parsed.warnings.some((w) => w.includes('x-catm-quality'))).toBe(true);
    expect(parsed.units[0]!.variants[0]!.restoredQuality).toBe(2);
  });

  it('carries usagecount/lastusagedate through from both <tu> and <tuv>', () => {
    const parsed = parseTmx(
      tmx(`
<tu usagecount="104" lastusagedate="20260203T063233Z">
  <tuv xml:lang="en" usagecount="9" lastusagedate="20260101T000000Z"><seg>a</seg></tuv>
  <tuv xml:lang="es"><seg>b</seg></tuv>
</tu>`),
    );
    const tu = parsed.units[0]!;
    expect(tu.usagecount).toBe('104');
    expect(tu.lastusagedate).toBe('20260203T063233Z');
    expect(tu.variants[0]).toMatchObject({
      usagecount: '9',
      lastusagedate: '20260101T000000Z',
    });
    expect(tu.variants[1]!.usagecount).toBeUndefined();
  });

  it('restores x-catm-uuid / x-catm-rev from our own export rather than treating them as generic props', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <prop type="x-catm-uuid">11111111-1111-1111-1111-111111111111</prop>
  <prop type="x-catm-rev">3</prop>
  <tuv xml:lang="en"><seg>Save</seg></tuv>
</tu>`),
    );
    const tu = parsed.units[0]!;
    expect(tu.restoredUuid).toBe('11111111-1111-1111-1111-111111111111');
    expect(tu.restoredRev).toBe(3);
    expect(tu.props.some((p) => p.type.startsWith('x-catm-'))).toBe(false);
  });

  it('restores x-catm-quality / x-catm-prev / x-catm-next / x-catm-rev per variant', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="es">
    <prop type="x-catm-quality">3</prop>
    <prop type="x-catm-prev">hash-a</prop>
    <prop type="x-catm-next">hash-b</prop>
    <prop type="x-catm-rev">2</prop>
    <seg>Guardar</seg>
  </tuv>
</tu>`),
    );
    const tuv = parsed.units[0]!.variants[0]!;
    expect(tuv.restoredQuality).toBe(3);
    expect(tuv.restoredPrevHash).toBe('hash-a');
    expect(tuv.restoredNextHash).toBe('hash-b');
    expect(tuv.restoredRev).toBe(2);
  });

  it('decodes entities and CDATA in segment text', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="en"><seg>Tom &amp; Jerry &lt;3 <![CDATA[<raw> & stuff]]></seg></tuv>
</tu>`),
    );
    // Two adjacent text nodes (the run before CDATA, then the CDATA
    // content) — segToTokens does not coalesce them; nothing downstream
    // needs it to, since plainText concatenates regardless.
    expect(parsed.units[0]!.variants[0]!.tokens).toEqual([
      { t: 'text', v: 'Tom & Jerry <3 ' },
      { t: 'text', v: '<raw> & stuff' },
    ]);
  });

  it('warns rather than fails on a malformed xml:lang, and still imports the unit', () => {
    const parsed = parseTmx(
      tmx(`
<tu>
  <tuv xml:lang="not a lang!!"><seg>x</seg></tuv>
</tu>`),
    );
    expect(parsed.units).toHaveLength(1);
    expect(parsed.warnings.some((w) => w.includes('not a lang!!'))).toBe(true);
  });

  it('reads the header srclang', () => {
    const parsed = parseTmx(tmx('<tu><tuv xml:lang="en"><seg>x</seg></tuv></tu>'));
    expect(parsed.srcLang).toBe('en');
  });

  it('throws when there is no <body>', () => {
    expect(() => parseTmx('<tmx version="1.4"><header srclang="en"/></tmx>')).toThrow(
      TmxError,
    );
  });
});

describe('tmxDateToIso', () => {
  it('converts the TMX date form to ISO 8601', () => {
    expect(tmxDateToIso('20260315T093000Z')).toBe('2026-03-15T09:30:00.000Z');
  });

  it('returns undefined for a missing or malformed date rather than throwing', () => {
    expect(tmxDateToIso(undefined)).toBeUndefined();
    expect(tmxDateToIso('not-a-date')).toBeUndefined();
  });
});

describe('isoToTmxDate', () => {
  it('is the inverse of tmxDateToIso', () => {
    expect(isoToTmxDate('2026-03-15T09:30:00.000Z')).toBe('20260315T093000Z');
    expect(tmxDateToIso(isoToTmxDate('2026-03-15T09:30:00.000Z'))).toBe(
      '2026-03-15T09:30:00.000Z',
    );
  });
});

function tuv(overrides: Partial<TmxExportTuv> & { lang: string }): TmxExportTuv {
  return {
    tokens: [{ t: 'text', v: 'x' }],
    quality: 2,
    rev: 1,
    prevHash: null,
    nextHash: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: null,
    usageCount: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

function tu(overrides: Partial<TmxExportTu> & { variants: TmxExportTuv[] }): TmxExportTu {
  return {
    uuid: 'unit-uuid',
    rev: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: null,
    props: [],
    ...overrides,
  };
}

function doc(units: TmxExportTu[]): TmxExportDoc {
  return { units, creationTool: 'cat-tool/test' };
}

describe('serializeTmx', () => {
  it('round-trips a plain-text bilingual unit through parseTmx', () => {
    const xml = serializeTmx(
      doc([
        tu({
          uuid: 'u-1',
          variants: [
            tuv({ lang: 'en', tokens: [{ t: 'text', v: 'Hello world' }] }),
            tuv({ lang: 'es', tokens: [{ t: 'text', v: 'Hola mundo' }] }),
          ],
        }),
      ]),
    );
    const parsed = parseTmx(xml);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]!.variants).toEqual([
      expect.objectContaining({ lang: 'en', tokens: [{ t: 'text', v: 'Hello world' }] }),
      expect.objectContaining({ lang: 'es', tokens: [{ t: 'text', v: 'Hola mundo' }] }),
    ]);
  });

  it('writes header srclang="*all*" — no single designated source language', () => {
    const xml = serializeTmx(doc([tu({ variants: [tuv({ lang: 'en' })] })]));
    expect(xml).toContain('srclang="*all*"');
  });

  it('round-trips open/close tag pairs and their TagKind hint via <bpt>/<ept>', () => {
    const tokens: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'bold' },
      { t: 'close', id: 1 },
    ];
    const xml = serializeTmx(doc([tu({ variants: [tuv({ lang: 'en', tokens })] })]));
    const parsed = parseTmx(xml);
    expect(parsed.units[0]!.variants[0]!.tokens).toEqual(tokens);
  });

  it('round-trips a ph placeholder and its TagKind hint, with no id/x correlation needed', () => {
    const tokens: TmToken[] = [{ t: 'ph', id: 7, k: 'image' }];
    const xml = serializeTmx(doc([tu({ variants: [tuv({ lang: 'en', tokens })] })]));
    const parsed = parseTmx(xml);
    // import assigns a fresh local id in document order — 1, not 7 — since
    // TMX <ph> carries no correlation attribute for it (§8 implementation notes).
    expect(parsed.units[0]!.variants[0]!.tokens).toEqual([
      { t: 'ph', id: 1, k: 'image' },
    ]);
  });

  it('escapes &, <, > in text and quotes in attribute values', () => {
    const tokens: TmToken[] = [{ t: 'text', v: 'Tom & Jerry <3 "quoted"' }];
    const xml = serializeTmx(
      doc([tu({ uuid: 'a "quoted" uuid', variants: [tuv({ lang: 'en', tokens })] })]),
    );
    expect(xml).not.toContain('Tom & Jerry <3');
    const parsed = parseTmx(xml);
    expect(parsed.units[0]!.variants[0]!.tokens).toEqual(tokens);
    expect(parsed.units[0]!.restoredUuid).toBe('a "quoted" uuid');
  });

  it('restores quality, rev, prev_hash, next_hash, and uuid/rev via x-catm-* props', () => {
    const xml = serializeTmx(
      doc([
        tu({
          uuid: 'restore-me',
          rev: 3,
          variants: [
            tuv({
              lang: 'en',
              quality: 4,
              rev: 2,
              prevHash: 'hash-before',
              nextHash: 'hash-after',
            }),
          ],
        }),
      ]),
    );
    const parsed = parseTmx(xml);
    const [parsedTu] = parsed.units;
    expect(parsedTu!.restoredUuid).toBe('restore-me');
    expect(parsedTu!.restoredRev).toBe(3);
    const [variant] = parsedTu!.variants;
    expect(variant!.restoredQuality).toBe(4);
    expect(variant!.restoredRev).toBe(2);
    expect(variant!.restoredPrevHash).toBe('hash-before');
    expect(variant!.restoredNextHash).toBe('hash-after');
  });

  it("writes tu_attr's tuid key as the <tu tuid> attribute, never a <prop>", () => {
    const xml = serializeTmx(
      doc([tu({ tuid: 'external-id-1', variants: [tuv({ lang: 'en' })] })]),
    );
    expect(xml).toContain('tuid="external-id-1"');
    expect(xml).not.toContain('type="tuid"');
    const parsed = parseTmx(xml);
    expect(parsed.units[0]!.tuid).toBe('external-id-1');
  });

  it("writes tu_attr's note key as a <note> child, never a <prop>", () => {
    const xml = serializeTmx(
      doc([tu({ note: 'translator comment', variants: [tuv({ lang: 'en' })] })]),
    );
    expect(xml).toContain('<note>translator comment</note>');
    expect(xml).not.toContain('type="note"');
    const parsed = parseTmx(xml);
    expect(parsed.units[0]!.props).toContainEqual({
      type: 'note',
      value: 'translator comment',
    });
  });

  it('writes every other tu_attr key as an ordinary <prop>, reserved keys included verbatim', () => {
    const xml = serializeTmx(
      doc([
        tu({
          props: [
            { type: 'client', value: 'Acme' },
            { type: 'x-custom-field', value: 'value' },
          ],
          variants: [tuv({ lang: 'en' })],
        }),
      ]),
    );
    const parsed = parseTmx(xml);
    expect(parsed.units[0]!.props).toContainEqual({ type: 'client', value: 'Acme' });
    expect(parsed.units[0]!.props).toContainEqual({
      type: 'x-custom-field',
      value: 'value',
    });
  });

  it('omits a unit with no variants entirely, rather than emitting a <tu> with no <tuv>', () => {
    const xml = serializeTmx(
      doc([tu({ variants: [] }), tu({ variants: [tuv({ lang: 'en' })] })]),
    );
    const parsed = parseTmx(xml);
    expect(parsed.units).toHaveLength(1);
  });

  it('falls back to updated_by for both creationid and changeid — tuv has no created_by column', () => {
    const xml = serializeTmx(
      doc([tu({ variants: [tuv({ lang: 'en', updatedBy: 'alice' })] })]),
    );
    expect((xml.match(/creationid="alice"/g) ?? []).length).toBe(1);
    expect((xml.match(/changeid="alice"/g) ?? []).length).toBe(1);
  });

  it('produces a document parseTmx accepts even with an empty memory', () => {
    const xml = serializeTmx(doc([]));
    const parsed = parseTmx(xml);
    expect(parsed.units).toHaveLength(0);
  });
});

describe('TmxStreamParser', () => {
  /** Units in a CDATA/comment/entity-heavy body — every hazard the unit scanner skips. */
  const doc =
    '\uFEFF' +
    tmx(
      `
<!-- a comment with </tu> in it -->
<tu tuid="1" creationid='a>b'>
  <prop type="x-Note">&lt;/tu&gt; is text here</prop>
  <tuv xml:lang="en"><seg><![CDATA[a </tu> inside CDATA]]></seg></tuv>
  <tuv xml:lang="fr"><seg>caf\u00E9 <bpt i="1">&lt;b&gt;</bpt>gras<ept i="1">&lt;/b&gt;</ept></seg></tuv>
</tu>
<tu tuid="2"><tuv xml:lang="bad lang"><seg>two</seg></tuv></tu>
<tu tuid="3"><!-- </tu> --><tuv xml:lang="bad lang"><seg>three</seg></tuv></tu>`,
      '<header srclang="en-US"><!-- <body> in a comment is not the body --><prop type="x-h">&lt;body&gt;</prop></header>',
    );

  function streamed(chunks: readonly string[]): {
    units: ParsedTmxTu[];
    srcLang: string | undefined;
    warnings: string[];
  } {
    const parser = new TmxStreamParser();
    const units = chunks.flatMap((c) => parser.push(c));
    parser.end();
    return { units, srcLang: parser.srcLang, warnings: parser.warnings() };
  }

  it("gives parseTmx's exact result whichever offset the input is split at", () => {
    const whole = parseTmx(doc);
    expect(whole.units.map((u) => u.tuid)).toEqual(['1', '2', '3']);
    expect(whole.units[0]!.variants[0]!.tokens).toEqual([
      { t: 'text', v: 'a </tu> inside CDATA' },
    ]);
    for (let at = 0; at <= doc.length; at++) {
      const got = streamed([doc.slice(0, at), doc.slice(at)]);
      expect(got.units, `split at ${at}`).toEqual(whole.units);
      expect(got.srcLang, `split at ${at}`).toBe('en-US');
      expect(got.warnings, `split at ${at}`).toEqual(whole.warnings);
    }
  });

  it('survives one character at a time', () => {
    expect(streamed([...doc]).units).toEqual(parseTmx(doc).units);
  });

  it('returns each unit as soon as its closing tag arrives, and holds nothing after', () => {
    const parser = new TmxStreamParser();
    const cut = doc.indexOf('<tu tuid="2"');
    expect(parser.push(doc.slice(0, cut)).map((u) => u.tuid)).toEqual(['1']);
    expect(parser.push(doc.slice(cut)).map((u) => u.tuid)).toEqual(['2', '3']);
    parser.end();
  });

  it('reports a bad xml:lang once per distinct value, with a count', () => {
    const lines = parseTmx(doc).warnings.filter((w) => w.includes('bad lang'));
    expect(lines).toEqual([
      expect.stringMatching(/^2 <tuv> variant\(s\) have xml:lang="bad lang"/),
    ]);
  });

  it('refuses an element other than <tu> in <body> rather than skipping it', () => {
    expect(() =>
      parseTmx(tmx('<tu><tuv xml:lang="en"><seg>x</seg></tuv></tu><note>n</note>')),
    ).toThrow(/unexpected <note> in <body>/);
  });

  it('throws on a document that stops inside a unit or before </body>', () => {
    const full = tmx('<tu><tuv xml:lang="en"><seg>x</seg></tuv></tu>');
    const parser = new TmxStreamParser();
    parser.push(full.slice(0, full.indexOf('</seg>')));
    expect(() => parser.end()).toThrow(/unterminated element <tu>/);
    const noClose = new TmxStreamParser();
    noClose.push(full.slice(0, full.indexOf('</body>')));
    expect(() => noClose.end()).toThrow(/unterminated element <body>/);
  });

  it('accepts an empty self-closing <body/>', () => {
    const parsed = parseTmx('<tmx version="1.4"><header srclang="en"/><body/></tmx>');
    expect(parsed.units).toEqual([]);
    expect(parsed.srcLang).toBe('en');
  });
});
