import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importDocx, translatableSegments } from '../docx/document.js';
import { renderRegion } from '../docx/render.js';
import { tokenizeRegion, tokensText } from '../docx/tokenize.js';
import { validateTagStructure } from '../model/tags.js';
import { rulesFor, SUPPORTED_LANGUAGES } from './rules.js';
import { findBoundaries, segmentsAreValid, segmentTokens } from './segmenter.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** Splits text into sentences, for readable assertions. */
function sentences(text: string, lang = 'en'): string[] {
  const rules = rulesFor(lang);
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

describe('findBoundaries — the basics', () => {
  it('splits on a period', () => {
    expect(sentences('One thing. Another thing.')).toEqual([
      'One thing.',
      'Another thing.',
    ]);
  });

  it('splits on question and exclamation marks', () => {
    expect(sentences('Really? Yes! Fine.')).toEqual(['Really?', 'Yes!', 'Fine.']);
  });

  it('does not split at the end of the text', () => {
    expect(findBoundaries('Only one sentence.', rulesFor('en'))).toEqual([]);
  });

  it('keeps a closing quote with its sentence', () => {
    expect(sentences('He said "go." Then he left.')).toEqual([
      'He said "go."',
      'Then he left.',
    ]);
  });

  it('does not split without following whitespace', () => {
    // A period inside a URL or a version number is not a sentence end.
    expect(sentences('See example.com/a.b for details.')).toHaveLength(1);
  });

  it('does not split on a lowercase continuation', () => {
    expect(sentences('Ref. no. 5 applies here.')).toHaveLength(1);
  });

  it('leaves colons and semicolons alone by default', () => {
    expect(sentences('First: second; third.')).toHaveLength(1);
  });
});

describe('findBoundaries — the traps', () => {
  it('does not treat ".." as a sentence end', () => {
    // The second dot must not be re-scanned as a single terminator.
    expect(sentences('Hi.. There we go.')).toEqual(['Hi.. There we go.']);
  });

  it('does not split inside a decimal', () => {
    expect(sentences('It grew 3.14 percent. Then it fell.')).toEqual([
      'It grew 3.14 percent.',
      'Then it fell.',
    ]);
  });

  it('does not split after an initial', () => {
    expect(sentences('J. R. Smith wrote it. He signed it.')).toEqual([
      'J. R. Smith wrote it.',
      'He signed it.',
    ]);
  });

  it('does not split after a known abbreviation', () => {
    expect(sentences('We studied Mr. Smith and Dr. Jones together.')).toHaveLength(1);
    expect(sentences('See Fig. 3 and vol. 2 for the rest.')).toHaveLength(1);
  });

  it('keeps a sentence whole even when the abbreviation could end it', () => {
    // "etc." genuinely can end a sentence, so this is ambiguous. The bias
    // is deliberate: a false break hands the translator half a sentence
    // and writes a fragment into the memory that will never match again,
    // whereas a missed break only produces a longer segment that the
    // translator can split by hand (#14). Erring toward the longer
    // segment is the recoverable mistake.
    expect(sentences('Bring pens, paper, etc. Then we begin.')).toHaveLength(1);
  });

  it('treats an ellipsis as one terminator', () => {
    expect(sentences('He paused... Then he spoke.')).toEqual([
      'He paused...',
      'Then he spoke.',
    ]);
  });

  it('does not break on an ellipsis followed by lowercase', () => {
    expect(sentences('He paused... and then spoke.')).toHaveLength(1);
  });

  it('does not break on a double period', () => {
    expect(sentences('Wait.. what happened here.')).toHaveLength(1);
  });
});

describe('findBoundaries — Spanish', () => {
  const es = (t: string) => sentences(t, 'es');

  it('recognises a sentence opening with an inverted mark', () => {
    // The case a naive "next char is uppercase" test gets wrong: ¿ is not
    // an uppercase letter, so the boundary is missed and two sentences
    // arrive as one.
    expect(es('Está aquí. ¿Dónde vamos?')).toEqual(['Está aquí.', '¿Dónde vamos?']);
    expect(es('Vamos. ¡Qué bien!')).toEqual(['Vamos.', '¡Qué bien!']);
  });

  it('splits after an inverted-mark sentence', () => {
    expect(es('¿Quién es? Es Pedro.')).toEqual(['¿Quién es?', 'Es Pedro.']);
  });

  it('does not split on Spanish honorifics', () => {
    expect(es('Habló el Sr. Gómez y la Sra. Ruiz ayer.')).toHaveLength(1);
    expect(es('Lo dijo Mons. Ferraro en la homilía.')).toHaveLength(1);
    expect(es('Escribió el Rvdo. P. Alonso en su carta.')).toHaveLength(1);
  });

  it('does not split on citation abbreviations', () => {
    expect(es('Véase art. 5 y págs. 20-30 del volumen.')).toHaveLength(1);
    expect(es('Fundada en 1838, cf. cap. 3 del libro.')).toHaveLength(1);
  });

  it('handles guillemets around a quoted sentence', () => {
    expect(es('Dijo «vamos». Luego salió.')).toEqual(['Dijo «vamos».', 'Luego salió.']);
  });
});

describe('findBoundaries — German and Dutch ordinals', () => {
  it('does not split a German date', () => {
    // The dominant German false break.
    expect(sentences('Am 1. Januar beginnt das Jahr.', 'de')).toHaveLength(1);
    expect(sentences('Der 3. Absatz ist wichtig.', 'de')).toHaveLength(1);
  });

  it('still splits a German sentence ending in a number', () => {
    expect(sentences('Wir zählten 20. Dann gingen wir.', 'de')).toHaveLength(2);
  });

  it('does not split a Dutch ordinal', () => {
    expect(sentences('Op 5. januari begint het.', 'nl')).toHaveLength(1);
  });

  it('does not split on German abbreviations', () => {
    expect(sentences('Das gilt z.B. für alle Fälle hier.', 'de')).toHaveLength(1);
    expect(sentences('Vgl. Kap. 4 und Abb. 2 dazu.', 'de')).toHaveLength(1);
  });
});

describe('findBoundaries — other languages', () => {
  it('handles French honorifics', () => {
    expect(sentences('M. Dupont et Mme Curie sont arrivés.', 'fr')).toHaveLength(1);
    expect(sentences('Voir chap. 2, p. 15 environ.', 'fr')).toHaveLength(1);
  });

  it('handles Italian honorifics', () => {
    expect(sentences('Il Dott. Rossi ha parlato ieri sera.', 'it')).toHaveLength(1);
  });

  it('handles Portuguese honorifics', () => {
    expect(sentences('O Sr. Silva chegou cedo hoje.', 'pt')).toHaveLength(1);
  });

  it('has rules for every supported language', () => {
    expect(SUPPORTED_LANGUAGES).toEqual([
      'en',
      'es',
      'fr',
      'de',
      'it',
      'pt',
      'nl',
      'ko',
      'vi',
    ]);
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(rulesFor(lang).abbreviations.length).toBeGreaterThan(10);
    }
  });

  it('falls back from a regional tag to its language', () => {
    expect(rulesFor('es-419').lang).toBe('es');
    expect(rulesFor('en-GB').lang).toBe('en');
    expect(rulesFor('pt_BR').lang).toBe('pt');
  });

  it('refuses a language it has no rules for', () => {
    expect(() => rulesFor('ja')).toThrow(/no segmentation rules/);
  });

  it('has rules for Korean', () => {
    const rules = rulesFor('ko');
    expect(rules.lang).toBe('ko');
    expect(rules.abbreviations).toBeDefined();
  });

  it('has rules for Vietnamese', () => {
    const rules = rulesFor('vi');
    expect(rules.lang).toBe('vi');
    expect(rules.abbreviations).toBeDefined();
  });

  it('supports Korean variants via primary subtag fallback', () => {
    const rules = rulesFor('ko-KR');
    expect(rules.lang).toBe('ko');
  });

  it('supports Vietnamese variants via primary subtag fallback', () => {
    const rules = rulesFor('vi-VN');
    expect(rules.lang).toBe('vi');
  });
});

describe('Korean and Vietnamese basic segmentation', () => {
  it('segments Korean text on period-like punctuation', () => {
    // Korean text: "First sentence. Second sentence."
    // Using standard periods as sentence terminators
    const ko = rulesFor('ko');
    const text = '첫 번째 문장. 두 번째 문장.';
    const cuts = findBoundaries(text, ko);
    expect(cuts.length).toBeGreaterThan(0);
  });

  it('segments Vietnamese text on periods', () => {
    // Vietnamese text: "First sentence. Second sentence."
    const vi = rulesFor('vi');
    const text = 'Câu thứ nhất. Câu thứ hai.';
    const cuts = findBoundaries(text, vi);
    expect(cuts.length).toBeGreaterThan(0);
  });

  it('handles Vietnamese with diacritics', () => {
    // Vietnamese with tone marks
    const vi = rulesFor('vi');
    const text = 'Đây là câu đầu tiên. Đây là câu thứ hai.';
    const cuts = findBoundaries(text, vi);
    expect(cuts.length).toBeGreaterThan(0);
  });
});

describe('segmentTokens — tag-aware splitting', () => {
  const es = rulesFor('es');
  const en = rulesFor('en');

  it('leaves a single sentence alone', () => {
    const r = tokenizeRegion('<w:r><w:t>One sentence only.</w:t></w:r>');
    expect(segmentTokens(r, en)).toHaveLength(1);
  });

  it('splits a paragraph into sentences', () => {
    const r = tokenizeRegion('<w:r><w:t>First one. Second one.</w:t></w:r>');
    const parts = segmentTokens(r, en);
    expect(parts.map((p) => tokensText(p.tokens).trim())).toEqual([
      'First one.',
      'Second one.',
    ]);
  });

  it('splits a pair that spans a boundary into two balanced pairs', () => {
    // The case that makes this hard: one italic span covering two
    // sentences must become two italic spans, each valid on its own.
    const r = tokenizeRegion('<w:r><w:rPr><w:i/></w:rPr><w:t>Uno. Dos.</w:t></w:r>');
    const parts = segmentTokens(r, es);
    expect(parts).toHaveLength(2);
    expect(segmentsAreValid(parts)).toBe(true);
    for (const part of parts) {
      expect(part.tokens.map((t) => t.t)).toEqual(['open', 'text', 'close']);
      expect(part.formats[0]!.kind).toBe('i');
    }
  });

  it('renumbers tag ids from 1 in each segment', () => {
    const r = tokenizeRegion(
      '<w:r><w:t>Plain. </w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>Bold text here.</w:t></w:r>',
    );
    const parts = segmentTokens(r, en);
    for (const part of parts) {
      expect(part.formats.map((f) => f.id)).toEqual(part.formats.map((_, i) => i + 1));
      for (const token of part.tokens) {
        if (token.t !== 'text') {
          expect(part.formats.some((f) => f.id === token.id)).toBe(true);
        }
      }
    }
  });

  it('keeps a placeholder with the sentence it belongs to', () => {
    const r = tokenizeRegion(
      '<w:r><w:t>Primera frase.</w:t></w:r>' +
        '<w:r><w:footnoteReference w:id="3"/></w:r>' +
        '<w:r><w:t> Segunda frase.</w:t></w:r>',
    );
    const parts = segmentTokens(r, es);
    expect(parts).toHaveLength(2);
    // The note reference follows the first sentence's period.
    expect(parts[0]!.tokens.some((t) => t.t === 'ph')).toBe(true);
  });

  it('preserves the full text across a split', () => {
    const xml = '<w:r><w:t>¿Quién? Nadie. ¡Vamos!</w:t></w:r>';
    const r = tokenizeRegion(xml);
    const parts = segmentTokens(r, es);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => tokensText(p.tokens)).join('')).toBe(tokensText(r.tokens));
  });

  it('drops segments that would be whitespace only', () => {
    const r = tokenizeRegion('<w:r><w:t>Uno.   </w:t></w:r>');
    expect(segmentTokens(r, es)).toHaveLength(1);
  });
});

describe('segmentTokens — against the real corpus', () => {
  const corpusRegions = (name: string) =>
    translatableSegments(importDocx(load(name))).map((s) => ({
      where: `${name} :: ${s.key}`,
      region: tokenizeRegion(s.xml),
    }));

  it('produces valid tag structure for every segment of the manuscript', () => {
    const es = rulesFor('es');
    for (const { where, region } of corpusRegions('footnotes-manuscript.docx')) {
      for (const part of segmentTokens(region, es)) {
        expect(validateTagStructure(part.tokens), where).toEqual({ ok: true });
      }
    }
  });

  it('never loses or invents text', () => {
    const es = rulesFor('es');
    for (const { where, region } of corpusRegions('footnotes-manuscript.docx')) {
      const joined = segmentTokens(region, es)
        .map((p) => tokensText(p.tokens))
        .join('');
      expect(joined.replace(/\s+/g, ' ').trim(), where).toBe(
        tokensText(region.tokens).replace(/\s+/g, ' ').trim(),
      );
    }
  });

  it('every produced segment renders to XML', () => {
    const es = rulesFor('es');
    for (const { where, region } of corpusRegions('footnotes-manuscript.docx')) {
      for (const part of segmentTokens(region, es)) {
        expect(() => renderRegion(part), where).not.toThrow();
      }
    }
  });

  it('actually splits the manuscript into more segments than paragraphs', () => {
    // A segmenter that never fires would pass every test above.
    const es = rulesFor('es');
    const regions = corpusRegions('footnotes-manuscript.docx');
    const after = regions.reduce(
      (n, { region }) => n + segmentTokens(region, es).length,
      0,
    );
    expect(after).toBeGreaterThan(regions.length * 1.3);
  });
});
