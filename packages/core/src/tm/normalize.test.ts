import { describe, expect, it } from 'vitest';

import type { TmToken } from '../model/token.js';
import {
  hashOf,
  normalizeText,
  normalizeTokens,
  NORMALIZER_VERSION,
} from './normalize.js';

// Every non-ASCII character below is written as an explicit \uXXXX escape,
// never as a bare glyph: several of these are invisible or
// near-indistinguishable from their canonical form in an editor, which is
// exactly how the two most common curly quotes once silently dropped out
// of tm-format-spec.md's own list of characters to fold.
const LEFT_SINGLE = '‘';
const RIGHT_SINGLE = '’';
const LOW_SINGLE = '‚';
const REVERSED_SINGLE = '‛';
const LEFT_DOUBLE = '“';
const RIGHT_DOUBLE = '”';
const LOW_DOUBLE = '„';
const REVERSED_DOUBLE = '‟';
const GUILLEMET_OPEN = '«';
const GUILLEMET_CLOSE = '»';
const EN_DASH = '–';
const EM_DASH = '—';
const FIGURE_DASH = '‒';
const NBSP = ' ';
const NNBSP = ' ';
const THIN_SPACE = ' ';
const ELLIPSIS = '…';
const PRIME = '′';
const DOUBLE_PRIME = '″';
const SOFT_HYPHEN = '­';
const E_ACUTE_PRECOMPOSED = 'é'; // é as one codepoint
const E_ACUTE_DECOMPOSED = 'é'; // e + combining acute accent
const A_ACUTE = 'á'; // á

describe('NORMALIZER_VERSION', () => {
  it('is 1, per the frozen rule set (tm-format-spec.md §4)', () => {
    expect(NORMALIZER_VERSION).toBe(1);
  });
});

describe('normalizeText', () => {
  it('folds every curly single-quote variant to a straight apostrophe', () => {
    const input = 'It' + LEFT_SINGLE + 's' + RIGHT_SINGLE + LOW_SINGLE + REVERSED_SINGLE;
    expect(normalizeText(input)).toBe("It's'''");
  });

  it('folds every curly double-quote and guillemet variant to a straight quote', () => {
    const input =
      LEFT_DOUBLE +
      'a' +
      RIGHT_DOUBLE +
      ' ' +
      LOW_DOUBLE +
      'b' +
      REVERSED_DOUBLE +
      ' ' +
      GUILLEMET_OPEN +
      'c' +
      GUILLEMET_CLOSE;
    expect(normalizeText(input)).toBe('"a" "b" "c"');
  });

  it('folds en, em, and figure dashes to a hyphen', () => {
    const input = 'a' + EN_DASH + 'b' + EM_DASH + 'c' + FIGURE_DASH + 'd';
    expect(normalizeText(input)).toBe('a-b-c-d');
  });

  it('folds NBSP, NNBSP, and thin space into the same canonical space a run collapses to', () => {
    expect(normalizeText('Mr.' + NBSP + 'Smith')).toBe('Mr. Smith');
    expect(normalizeText('a' + NNBSP + 'b' + THIN_SPACE + 'c')).toBe('a b c');
    expect(normalizeText('x' + NBSP + NBSP + 'y')).toBe('x y'); // a run still collapses to one
  });

  it('folds ellipsis to three literal dots', () => {
    expect(normalizeText('Wait' + ELLIPSIS)).toBe('Wait...');
  });

  it('folds primes to the quote marks they resemble', () => {
    expect(normalizeText('5' + PRIME + ' 10' + DOUBLE_PRIME)).toBe(`5' 10"`);
  });

  it('removes soft hyphens entirely — they are not visible characters', () => {
    expect(normalizeText('extra' + SOFT_HYPHEN + 'ordinary')).toBe('extraordinary');
  });

  it('collapses whitespace runs to one space and trims both ends', () => {
    expect(normalizeText('  a   b\t\tc\n\nd  ')).toBe('a b c d');
  });

  it('applies NFC — a decomposed accent matches its precomposed form', () => {
    expect(normalizeText(E_ACUTE_DECOMPOSED)).toBe(normalizeText(E_ACUTE_PRECOMPOSED));
    expect(normalizeText(E_ACUTE_DECOMPOSED)).toBe(E_ACUTE_PRECOMPOSED);
  });

  it('preserves case', () => {
    expect(normalizeText('Hello')).not.toBe(normalizeText('hello'));
  });

  it('preserves diacritics — ácido and acido are different units', () => {
    expect(normalizeText(A_ACUTE + 'cido')).not.toBe(normalizeText('acido'));
  });
});

describe('hashOf', () => {
  it('is the same regardless of which typographic variant was used', () => {
    const straight = `It's a "test" - one, two... done`;
    const curly =
      'It' +
      RIGHT_SINGLE +
      's a ' +
      LEFT_DOUBLE +
      'test' +
      RIGHT_DOUBLE +
      ' ' +
      EN_DASH +
      ' one, two' +
      ELLIPSIS +
      ' done';
    expect(hashOf(straight)).toBe(hashOf(curly));
  });

  it('differs on case even though the typographic form matches', () => {
    expect(hashOf('Hello world')).not.toBe(hashOf('hello world'));
  });

  it('is a lowercase hex SHA-256 digest', () => {
    expect(hashOf('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeTokens', () => {
  it('drops tags before normalising, sharing plainText with the reduced TM token model', () => {
    const tokens: TmToken[] = [
      { t: 'text', v: 'It' + RIGHT_SINGLE + 's ' },
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'bold' },
      { t: 'close', id: 1 },
      { t: 'text', v: '  ' + ELLIPSIS },
    ];
    const { plain, hash } = normalizeTokens(tokens);
    expect(plain).toBe("It's bold ...");
    expect(hash).toBe(hashOf("It's bold ..."));
  });

  it('produces the same hash for text-equivalent Token and TmToken streams', () => {
    const asTmToken: TmToken[] = [{ t: 'text', v: 'Caf' + E_ACUTE_PRECOMPOSED }];
    const asToken = [{ t: 'text' as const, v: 'Caf' + E_ACUTE_PRECOMPOSED }];
    expect(normalizeTokens(asTmToken).hash).toBe(normalizeTokens(asToken).hash);
  });
});
