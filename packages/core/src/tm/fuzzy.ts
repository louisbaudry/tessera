/**
 * Fuzzy scoring: FS-2 (`v1-spec.md` §6.1a; backlog #61).
 *
 * Pure, like the rest of `core/tm`: two segments' words and visible tags in,
 * an integer score out. Where the candidates come from (the shortlist) is
 * `db`'s; this is only the answer to "how close are these two?". FS-1, the
 * research baseline in `db/tm/bench/stats.ts`, is deliberately a separate
 * function: a new scorer is never a silent change to the old one
 * (`semantic-matching-spec.md` §2).
 */

import { withoutHiddenTags } from '../model/hidden-tags.js';
import { normalizeText } from './normalize.js';
import { plainText } from '../model/token.js';
import type { FormatEntry, TmToken, Token } from '../model/token.js';

/** Below this a unit is a no-match for analysis and pay (`v1-spec.md` §6.1a, 2). */
export const FUZZY_FLOOR = 50;

/** The default for the lowest score pre-translate will write into a segment. */
export const DEFAULT_FUZZY_THRESHOLD = 75;

/** The best a fuzzy score can be: 100 is the exact tier, which is hash-based. */
export const FUZZY_MAX_SCORE = 99;

/** Points taken for each numeral whose value differs. */
const NUMBER_PENALTY = 2;
/** Points taken for each tag on one side only, and the most they can cost. */
const TAG_PENALTY = 1;
const TAG_PENALTY_CAP = 5;

/**
 * What the scorer reads of a segment or a memory unit's source: its
 * normalised text and its visible tags as `open:bold`-style slots, in
 * document order. A slot is the tag's role and kind, the same notion
 * `remapTmTokens` matches on.
 */
export interface FuzzyOperand {
  readonly plain: string;
  readonly tagSlots: readonly string[];
  /**
   * Every tag of a project segment, hidden ones too. A unit written by
   * another tool tags every run, so its tags can only correspond to the
   * segment's own once the hidden ones count; `remapTmTokens` makes the same
   * second try, and the score agrees with it. Absent on a memory unit.
   */
  readonly allTagSlots?: readonly string[];
}

/** A project segment's source as the scorer reads it: visible tags only. */
export function operandOfSource(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): FuzzyOperand {
  const kindById = new Map(formats.map((f) => [f.id, f.kind]));
  const slotsOf = (list: readonly Token[]): string[] => {
    const slots: string[] = [];
    for (const t of list) {
      if (t.t === 'open' || t.t === 'ph')
        slots.push(`${t.t}:${kindById.get(t.id) ?? '?'}`);
    }
    return slots;
  };
  const visible = withoutHiddenTags(tokens, formats);
  return {
    plain: normalizeText(plainText(visible)),
    tagSlots: slotsOf(visible),
    allTagSlots: slotsOf(tokens),
  };
}

/**
 * A memory unit's source as the scorer reads it. A memory this tool wrote
 * holds no hidden tags (`toTmTokens`); one from another tool may, and those
 * count as tags the segment has no counterpart for, which is the penalty
 * they earn.
 */
export function operandOfTm(
  tokens: readonly TmToken[],
  plain: string = normalizeText(plainText(tokens)),
): FuzzyOperand {
  const tagSlots: string[] = [];
  for (const t of tokens) {
    if (t.t === 'open' || t.t === 'ph') tagSlots.push(`${t.t}:${t.k ?? '?'}`);
  }
  return { plain, tagSlots };
}

/** A numeral: digits, with `.` or `,` between groups (`3.5`, `1,000`, `14:2` is two). */
const NUMERAL = /^\p{N}/u;
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}]+/gu;
/** Stands for any numeral in the distance, so only a changed value, not a changed word, costs. */
const NUMBER_CLASS = '\u0001';

interface Words {
  /** Words, lowercased, with every numeral replaced by {@link NUMBER_CLASS}. */
  readonly seq: readonly string[];
  /** The numerals' own text, in order. */
  readonly numerals: readonly string[];
}

function wordsOf(plain: string): Words {
  const seq: string[] = [];
  const numerals: string[] = [];
  for (const m of plain.matchAll(TOKEN)) {
    const w = m[0];
    if (NUMERAL.test(w)) {
      seq.push(NUMBER_CLASS);
      numerals.push(w);
    } else {
      seq.push(w.toLowerCase());
    }
  }
  return { seq, numerals };
}

/**
 * Word-level Levenshtein distance, abandoned as soon as it must exceed
 * `limit`; `null` then. Two rows, the shorter on the inside.
 */
function distance(
  a: readonly string[],
  b: readonly string[],
  limit: number,
): number | null {
  if (a.length < b.length) [a, b] = [b, a];
  if (a.length - b.length > limit) return null;
  const n = b.length;
  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return null;
    [prev, cur] = [cur, prev];
  }
  const d = prev[n]!;
  return d > limit ? null : d;
}

/** Tags on one side only, counted by slot. */
function tagDifference(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const s of a) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const s of b) counts.set(s, (counts.get(s) ?? 0) - 1);
  let diff = 0;
  for (const c of counts.values()) diff += Math.abs(c);
  return diff;
}

/**
 * The FS-2 score of `candidate` against `segment`, an integer 0–99, or `null`
 * when it is under `minScore` (the scorer stops early rather than finishing a
 * distance nobody will use).
 *
 * - Word-level edit distance over the normalised text, case folded.
 * - Numerals compare as a class; each pair, in order, whose values differ
 *   costs 2 points, so a changed number is not priced as a replaced word.
 * - Each tag on one side only costs 1 point, at most 5. The segment's visible
 *   tags are compared first, and all of its tags when that is closer.
 * - Rounded down, and never 100: that is the exact tier, which is hash-based
 *   and case-sensitive. A pair that differs only in case or punctuation is 99.
 *
 * A text with no words (only punctuation, or empty) has no score. The caller
 * refuses unspaced languages (`hasSpacedWords`) before it gets here.
 */
export function scoreFuzzy(
  segment: FuzzyOperand,
  candidate: FuzzyOperand,
  minScore: number = FUZZY_FLOOR,
): number | null {
  const a = wordsOf(segment.plain);
  const b = wordsOf(candidate.plain);
  const longer = Math.max(a.seq.length, b.seq.length);
  if (longer === 0) return null;

  // The base can only fall with penalties, so a base under `minScore`
  // cannot recover: bound the distance by what `minScore` allows.
  const limit = Math.floor((longer * (100 - minScore)) / 100);
  const d = distance(a.seq, b.seq, limit);
  if (d === null) return null;

  const base = Math.floor((100 * (longer - d)) / longer);
  let numberMisses = 0;
  const pairs = Math.min(a.numerals.length, b.numerals.length);
  for (let i = 0; i < pairs; i++) if (a.numerals[i] !== b.numerals[i]) numberMisses++;
  const tagDiff = Math.min(
    tagDifference(segment.tagSlots, candidate.tagSlots),
    segment.allTagSlots
      ? tagDifference(segment.allTagSlots, candidate.tagSlots)
      : Infinity,
  );
  const tagCost = Math.min(TAG_PENALTY_CAP, TAG_PENALTY * tagDiff);

  const score = Math.min(FUZZY_MAX_SCORE, base - NUMBER_PENALTY * numberMisses - tagCost);
  return score >= minScore ? score : null;
}
