/**
 * Concordance search, the pure half (`v1-spec.md` §6.1b; issue #170): which
 * words a typed or selected text asks for, the FTS5 expression that finds them
 * as one phrase, and where in a hit they sit so a page can mark them. The
 * query itself is `db/tm/concordance.ts`'s; nothing here touches a database.
 *
 * The folding mirrors the memory's tokenizer (`unicode61 remove_diacritics 2`,
 * `tm-format-spec.md` §2.6): words are runs of letters, marks and digits,
 * lower-cased with diacritics removed. Keeping that in one place is what lets
 * a page mark exactly what the index matched, and hold no tokenizer of its own.
 */

/** Words in a concordance query, at most; more is a sentence, not a lookup. */
export const CONCORDANCE_MAX_WORDS = 12;

/** Characters in a concordance query, at most. */
export const CONCORDANCE_MAX_CHARS = 120;

/** Hits returned across all memories, at most. */
export const CONCORDANCE_LIMIT = 50;

/** Which language of the pair is searched. */
export type ConcordanceSide = 'source' | 'target';

export const CONCORDANCE_SIDES: readonly ConcordanceSide[] = ['source', 'target'];

/** A span of a hit's text, in UTF-16 code units: `[start, end)`. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * A word as the index stores it: case-folded, diacritics stripped. The same
 * fold the fuzzy shortlist applies to a vocabulary lookup.
 */
export function foldWord(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The words a text asks for, folded, in order and with repeats kept (a phrase
 * "very very good" is three words). Empty for a text with no word.
 */
export function concordanceWords(text: string): string[] {
  return [...text.matchAll(WORD)].map((m) => foldWord(m[0]!)).filter((w) => w !== '');
}

/**
 * Why a text cannot be searched, or null when it can. A text with no word is
 * not an error to the caller (it is an empty result), so it is `null` here
 * too; only a text too long is refused.
 */
export function concordanceProblem(text: string): string | null {
  if (text.length > CONCORDANCE_MAX_CHARS) {
    return `Search for at most ${CONCORDANCE_MAX_CHARS} characters.`;
  }
  if (concordanceWords(text).length > CONCORDANCE_MAX_WORDS) {
    return `Search for at most ${CONCORDANCE_MAX_WORDS} words.`;
  }
  return null;
}

/**
 * The FTS5 `MATCH` expression for the words: one quoted phrase, so the words
 * must be adjacent and in order. Every word is letters, marks and digits, so
 * nothing in it can be read as query syntax. `null` when there is no word.
 */
export function concordanceMatch(words: readonly string[]): string | null {
  if (words.length === 0) return null;
  return `"${words.join(' ')}"`;
}

/**
 * Where the phrase occurs in `text`: one range per occurrence, from the start
 * of its first word to the end of its last, in order and not overlapping.
 * Words are found and folded as the index does, so `acción` is marked by a
 * search for `accion` and `Set` by `set`.
 */
export function highlightRanges(text: string, words: readonly string[]): TextRange[] {
  if (words.length === 0) return [];
  const found = [...text.matchAll(WORD)].map((m) => ({
    word: foldWord(m[0]!),
    start: m.index,
    end: m.index + m[0]!.length,
  }));
  const ranges: TextRange[] = [];
  for (let i = 0; i + words.length <= found.length;) {
    if (words.every((w, k) => found[i + k]!.word === w)) {
      ranges.push({ start: found[i]!.start, end: found[i + words.length - 1]!.end });
      i += words.length;
    } else {
      i++;
    }
  }
  return ranges;
}
