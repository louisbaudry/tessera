/**
 * Stage 1 of detection (smart-glossary-spec.md §4.1, backlog #40): which
 * source terms repeat enough to be worth deciding once. Deterministic and
 * headless — sentences in, candidates out; no model, no DB, no network —
 * so every behaviour here is provable from a list of strings.
 */

import { normalizeText } from '../tm/normalize.js';
import type { Segment } from '../model/segment.js';
import { plainText } from '../model/token.js';
import { termKey } from './key.js';
import { stopwordsFor } from './stopwords.js';

export interface ExtractOptions {
  /** BCP-47 source language; picks the stopword list. */
  readonly srcLang: string;
  /** An n-gram must occur at least this often to be a candidate. Default 3. */
  readonly minOccurrences?: number;
  /** The longest n-gram, in words. Default 3. */
  readonly maxWords?: number;
}

export const DEFAULT_MIN_OCCURRENCES = 3;
export const DEFAULT_MAX_WORDS = 3;

/** A source term that repeats: the unit the aligner and the flagger work on. */
export interface Candidate {
  /** `termKey` of the term — what two occurrences are compared by. */
  readonly key: string;
  /** The term as written, from its first occurrence. */
  readonly term: string;
  /** How many times it occurs in all, including inside longer candidates. */
  readonly occurrences: number;
  /** `ord` of every segment it occurs in, ascending, once each. */
  readonly ords: readonly number[];
  /** Words in the n-gram. */
  readonly words: number;
}

/**
 * A word: letters and digits, with `-` and `.` allowed *inside* (`e-mail`,
 * `U.S`, `3.5`) and never at the end, so `Mons.` is the word `Mons` and
 * the full stop is punctuation after it.
 */
const WORD = /[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu;

/**
 * Between two words of one run there may be only spaces, or an apostrophe
 * (an elision: `l'accord`). Anything else — a comma, a quote, a bracket, a
 * dash, a full stop — ends the run, so an n-gram never spans a clause
 * boundary ("invoice, tax" is not a term).
 */
const SAME_RUN_GAP = /^(?:\s+|['’]\s*)$/;

/** A number alone is never a term, and ends the run like punctuation. */
const ALL_DIGITS = /^\p{N}+(?:[-.]\p{N}+)*$/u;

interface Word {
  readonly start: number;
  readonly end: number;
  readonly lower: string;
}

/** A run of words with nothing but spaces (or elisions) between them. */
function runsOf(text: string): Word[][] {
  const runs: Word[][] = [];
  let current: Word[] = [];
  let prevEnd = -1;
  const flush = () => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  for (const m of text.matchAll(WORD)) {
    const start = m.index;
    const end = start + m[0].length;
    if (ALL_DIGITS.test(m[0])) {
      flush();
      prevEnd = -1;
      continue;
    }
    if (prevEnd >= 0 && !SAME_RUN_GAP.test(text.slice(prevEnd, start))) flush();
    current.push({ start, end, lower: m[0].toLowerCase() });
    prevEnd = end;
  }
  flush();
  return runs;
}

interface Occurrence {
  readonly seg: number;
  readonly run: number;
  readonly start: number;
  readonly len: number;
  /** The span as written, for display. */
  readonly surface: string;
}

/** Whether a segment's source can hold a term at all (not locked, not a twin copy). */
function isExtractable(segment: Segment): boolean {
  return !segment.locked && segment.status !== 'locked' && !segment.fallbackCopy;
}

/**
 * `extractCandidates(segments, { srcLang })` — the repeated terms of a
 * document's source side.
 *
 * Counts the 1..`maxWords`-word n-grams of every extractable segment's
 * source text (locked segments are not the translator's to decide; a
 * text box's `mc:Fallback` copy is its twin's duplicate and would count
 * every term in it twice, as it would a word count — backlog #34). Text
 * is normalised first (`normalizeText`), and two spellings are one term
 * when their `termKey` is. An n-gram that begins or ends with a stopword
 * is dropped, and so is one under `minOccurrences`.
 *
 * **A longer term absorbs the shorter ones it contains**, but only the
 * occurrences it covers: "tax invoice" ×4 absorbs "invoice" ×4 and leaves
 * "invoice" ×7 with its three others. A shorter term whose uncovered
 * occurrences fall below `minOccurrences` is dropped — it is no longer
 * repeated on its own, and the panel would otherwise offer "invoice" and
 * "tax invoice" as two decisions about one thing.
 *
 * Result order is stable: most occurrences first, then longer, then by key.
 */
export function extractCandidates(
  segments: readonly Segment[],
  options: ExtractOptions,
): Candidate[] {
  const stop = stopwordsFor(options.srcLang);
  const min = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;

  const byKey = new Map<string, Occurrence[]>();
  const ordsOf = new Map<string, Set<number>>();
  let seg = 0;
  for (const segment of segments) {
    if (!isExtractable(segment)) continue;
    const text = normalizeText(plainText(segment.sourceTokens));
    const segIndex = seg++;
    runsOf(text).forEach((run, runIndex) => {
      const w = run;
      for (let start = 0; start < w.length; start++) {
        for (let len = 1; len <= maxWords && start + len <= w.length; len++) {
          if (stop.has(w[start]!.lower) || stop.has(w[start + len - 1]!.lower)) continue;
          const surface = text.slice(w[start]!.start, w[start + len - 1]!.end);
          const key = termKey(surface);
          let list = byKey.get(key);
          if (!list) byKey.set(key, (list = []));
          list.push({ seg: segIndex, run: runIndex, start, len, surface });
          let ords = ordsOf.get(key);
          if (!ords) ordsOf.set(key, (ords = new Set()));
          ords.add(segment.ord);
        }
      }
    });
  }

  const qualifying = [...byKey].filter(([, occ]) => occ.length >= min);

  // Every sub-span of every qualifying multi-word occurrence is covered.
  const covered = new Set<string>();
  const spanKey = (o: { seg: number; run: number }, start: number, len: number) =>
    `${o.seg}:${o.run}:${start}:${len}`;
  for (const [, occ] of qualifying) {
    for (const o of occ) {
      for (let len = 1; len < o.len; len++) {
        for (let start = o.start; start + len <= o.start + o.len; start++) {
          covered.add(spanKey(o, start, len));
        }
      }
    }
  }

  const out: Candidate[] = [];
  for (const [key, occ] of qualifying) {
    const uncovered = occ.filter((o) => !covered.has(spanKey(o, o.start, o.len))).length;
    if (uncovered < min) continue;
    out.push({
      key,
      term: occ[0]!.surface,
      occurrences: occ.length,
      ords: [...ordsOf.get(key)!].sort((a, b) => a - b),
      words: occ[0]!.len,
    });
  }
  return out.sort(
    (a, b) =>
      b.occurrences - a.occurrences || b.words - a.words || a.key.localeCompare(b.key),
  );
}
