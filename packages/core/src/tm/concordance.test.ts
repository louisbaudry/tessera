import { describe, expect, it } from 'vitest';

import {
  CONCORDANCE_MAX_CHARS,
  CONCORDANCE_MAX_WORDS,
  concordanceMatch,
  concordanceProblem,
  concordanceWords,
  foldWord,
  highlightRanges,
} from './concordance.js';

describe('concordanceWords', () => {
  it('folds case and diacritics, as the index does', () => {
    expect(concordanceWords('Acción RÁPIDA')).toEqual(['accion', 'rapida']);
    // A decomposed accent folds the same as a precomposed one.
    expect(concordanceWords('Acción')).toEqual(['accion']);
  });

  it('keeps digits and drops punctuation, so none of it can be query syntax', () => {
    expect(concordanceWords('"set up" (v2.0) -x* OR y')).toEqual([
      'set',
      'up',
      'v2',
      '0',
      'x',
      'or',
      'y',
    ]);
  });

  it('is empty for a text with no word', () => {
    expect(concordanceWords('  — ... ')).toEqual([]);
    expect(concordanceWords('')).toEqual([]);
  });
});

describe('concordanceMatch', () => {
  it('is one quoted phrase', () => {
    expect(concordanceMatch(['set', 'up'])).toBe('"set up"');
  });

  it('is null without a word', () => {
    expect(concordanceMatch([])).toBeNull();
  });
});

describe('concordanceProblem', () => {
  it('accepts an ordinary lookup and a text with no word', () => {
    expect(concordanceProblem('set up')).toBeNull();
    expect(concordanceProblem('...')).toBeNull();
  });

  it('refuses a text that is a sentence, by characters or by words', () => {
    expect(concordanceProblem('a'.repeat(CONCORDANCE_MAX_CHARS + 1))).not.toBeNull();
    const words = Array.from({ length: CONCORDANCE_MAX_WORDS + 1 }, () => 'a').join(' ');
    expect(concordanceProblem(words)).not.toBeNull();
    expect(
      concordanceProblem(
        Array.from({ length: CONCORDANCE_MAX_WORDS }, () => 'a').join(' '),
      ),
    ).toBeNull();
  });
});

describe('highlightRanges', () => {
  const marked = (text: string, words: string[]) =>
    highlightRanges(text, words).map((r) => text.slice(r.start, r.end));

  it('marks each occurrence of the phrase, as written in the text', () => {
    expect(marked('Set up the set up wizard.', ['set', 'up'])).toEqual([
      'Set up',
      'set up',
    ]);
  });

  it('finds a word whatever its case or accent', () => {
    expect(marked('La Acción y la acciÓn.', ['accion'])).toEqual(['Acción', 'acciÓn']);
  });

  it('needs the words adjacent and in order', () => {
    expect(marked('set the thing up', ['set', 'up'])).toEqual([]);
    expect(marked('up set', ['set', 'up'])).toEqual([]);
  });

  it('spans punctuation between the words of a phrase, as the tokenizer does', () => {
    expect(marked('the e-mail address', ['e', 'mail'])).toEqual(['e-mail']);
  });

  it('does not mark a word that only contains the query', () => {
    expect(marked('Settings and setup', ['set'])).toEqual([]);
  });

  it('does not let occurrences overlap', () => {
    expect(marked('very very very good', ['very', 'very'])).toEqual(['very very']);
  });

  it('is empty without words', () => {
    expect(highlightRanges('anything', [])).toEqual([]);
  });

  it('offsets are in UTF-16 units, so a surrogate pair before the hit does not shift it', () => {
    const text = '\u{1F600} set';
    const [range] = highlightRanges(text, ['set']);
    expect(text.slice(range!.start, range!.end)).toBe('set');
  });
});

describe('foldWord', () => {
  it('lower-cases and strips marks', () => {
    expect(foldWord('ÉTÉ')).toBe('ete');
  });
});
