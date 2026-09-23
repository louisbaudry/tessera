/**
 * SRX-lite sentence segmentation (planning/v1-spec.md §5.1; backlog #12).
 *
 * Two stages, deliberately separate:
 *
 *  1. {@link findBoundaries} works on plain text and answers "where do
 *     sentences end". It is pure and easy to test against a fixture list.
 *  2. {@link segmentTokens} maps those offsets back onto a tagged token
 *     stream, splitting any tag pair that spans a boundary into balanced
 *     pairs so each resulting segment is independently valid.
 *
 * Getting this wrong is not cosmetic. A false break mid-sentence gives the
 * translator half a sentence to translate and poisons the translation
 * memory with a fragment that will never match anything again.
 */

import { validateTagStructure } from '../model/tags.js';
import type { Token } from '../model/token.js';
import type { FormatEntry, TokenizedRegion } from '../docx/tokenize.js';
import {
  compileRule,
  type SegmentationProfile,
  type SegmentationRule,
} from './profile.js';
import type { LanguageRules } from './rules.js';

/**
 * What the segmenter accepts: the built-in defaults, or a resolved
 * profile carrying user rules and variables on top of them.
 */
export type SegmenterRules = LanguageRules | SegmentationProfile;

/** Sentence-ending punctuation. `:` and `;` are opt-in per language. */
const TERMINATORS = new Set(['.', '!', '?', '…']);

/** Closing marks that trail a terminator and belong to the same sentence. */
const TRAILING = new Set(['"', "'", '»', '”', '\u2018', ')', ']', '}', '›']);

/** Marks that can legitimately open a Spanish sentence. */
const INVERTED = new Set(['¿', '¡']);

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
const isUpper = (ch: string | undefined): boolean =>
  ch !== undefined && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
const isDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= '0' && ch <= '9';
const isLetter = (ch: string | undefined): boolean =>
  ch !== undefined && /\p{L}/u.test(ch);

/**
 * Whether a word is a known abbreviation.
 *
 * Tries the exact form first, then with the first letter case-flipped: a
 * normally-lowercase abbreviation is capitalised when it opens a sentence
 * ("Vgl. Kap. 4"), and a normally-capitalised one appears lowercase
 * mid-sentence ("Ref. no. 5"). Only the first letter is flipped, so `US`
 * never collides with `us`.
 */
function isAbbreviation(word: string, known: ReadonlySet<string>): boolean {
  if (word.length === 0) return false;
  if (known.has(word)) return true;
  const head = word[0]!;
  const rest = word.slice(1);
  return known.has(head.toLowerCase() + rest) || known.has(head.toUpperCase() + rest);
}

/** The word immediately before `at`, skipping one run of whitespace. */
function precedingWord(text: string, at: number): string {
  let end = at;
  while (end > 0 && isSpace(text[end - 1])) end--;
  let start = end;
  while (start > 0 && /[\p{L}\p{M}]/u.test(text[start - 1]!)) start--;
  return text.slice(start, end);
}

/** The word ending at `end` (exclusive), letters and interior dots only. */
function wordBefore(text: string, end: number): string {
  let start = end;
  while (start > 0 && /[\p{L}\p{M}.]/u.test(text[start - 1]!)) start--;
  return text.slice(start, end);
}

/**
 * Positions decided by the user's rules, evaluated in order with first
 * match winning per position (segmentation-spec.md §4). A position a rule
 * has decided is settled — the built-in logic never revisits it, because a
 * custom rule the built-ins can veto is not worth writing.
 *
 * A rule that fails to compile is skipped here defensively; the editing
 * surface reports it via {@link ruleProblems} before it is ever saved.
 */
function decideWithUserRules(
  text: string,
  rules: readonly SegmentationRule[],
): Map<number, boolean> {
  const decided = new Map<number, boolean>();
  for (const rule of rules) {
    const compiled = compileRule(rule);
    if ('error' in compiled) continue;
    for (const match of text.matchAll(compiled.before)) {
      const pos = match.index + match[0]!.length;
      if (pos <= 0 || pos >= text.length || decided.has(pos)) continue;
      if (compiled.after) {
        compiled.after.lastIndex = pos;
        if (!compiled.after.test(text)) continue;
      }
      decided.set(pos, rule.break);
    }
  }
  return decided;
}

/** Occurrences of each variable in the text, as [start, end) ranges. */
function variableRanges(
  text: string,
  variables: readonly string[],
): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (const variable of variables) {
    if (variable.length < 2) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(variable, from);
      if (at === -1) break;
      ranges.push([at, at + variable.length]);
      from = at + 1;
    }
  }
  return ranges;
}

const strictlyInside = (
  ranges: ReadonlyArray<readonly [number, number]>,
  pos: number,
): boolean => ranges.some(([start, end]) => pos > start && pos < end);

/**
 * Offsets at which a sentence ends, i.e. the index *after* the final
 * character of each sentence. Never includes the end of the text.
 *
 * Evaluation order (segmentation-spec.md §4): user rules decide first and
 * outrank everything; variables veto breaks inside themselves; the
 * built-in logic handles the rest.
 */
export function findBoundaries(text: string, rules: SegmenterRules): number[] {
  const boundaries: number[] = [];
  const terminators = new Set(TERMINATORS);
  if (rules.breakOnColon) terminators.add(':');
  if (rules.breakOnSemicolon) terminators.add(';');

  const abbreviations = new Set(rules.abbreviations);
  const userRules = 'userRules' in rules ? rules.userRules : [];
  const variables = 'variables' in rules ? rules.variables : [];
  const decided = decideWithUserRules(text, userRules);
  const protectedRanges = variableRanges(text, variables);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!terminators.has(ch)) continue;

    // An ellipsis is one terminator, not three.
    let end = i + 1;
    if (ch === '.') {
      while (text[end] === '.') end++;
      const dots = end - i;
      if (dots === 2) {
        // ".." is not a sentence end — and skip past both dots, or the
        // second would be re-scanned as an ordinary single terminator.
        i = end - 1;
        continue;
      }
      if (dots >= 3) {
        const pos = consumeTrailing(text, end);
        if (decided.get(pos) === false) continue;
        if (decided.get(pos) === true) {
          boundaries.push(pos);
          i = end - 1;
          continue;
        }
        if (strictlyInside(protectedRanges, pos)) continue;
        // "..." breaks only before something that opens a sentence.
        const after = skipSpace(text, end);
        if (!opensSentence(text, after, rules)) continue;
        boundaries.push(pos);
        i = end - 1;
        continue;
      }
    }

    const withTrailing = consumeTrailing(text, end);

    // A user rule that has decided this position settles it outright.
    const verdict = decided.get(withTrailing);
    if (verdict === false) continue;
    if (verdict === true) {
      boundaries.push(withTrailing);
      i = withTrailing - 1;
      continue;
    }

    // A break strictly inside a variable never happens.
    if (strictlyInside(protectedRanges, withTrailing)) continue;

    const next = skipSpace(text, withTrailing);

    // A terminator must be followed by whitespace. "3.14" and "e.g" are
    // not sentence ends, and neither is a period inside a URL.
    if (next === withTrailing) continue;

    if (ch === '.') {
      const previous = text[i - 1];

      // Decimal or thousands separator: 3.14, 1.000.
      if (isDigit(previous) && isDigit(text[i + 1])) continue;

      if (isDigit(previous)) {
        const following = text.slice(next).match(/^\p{L}+/u)?.[0];

        // Forward, the Trados model: a word that legitimately follows an
        // ordinal ("Frist: 30. Juni") means no break — in any language,
        // since the follower list is user-editable everywhere.
        if (following && rules.ordinalFollowers.includes(following)) continue;

        // Ordinal: "1. Januar", "Der 3. Absatz". German and Dutch write
        // dates and ordinals this way, and it is the dominant false break
        // in both.
        if (rules.ordinals) {
          // A lowercase continuation is never a new sentence.
          if (following && !isUpper(following[0])) continue;
          // German capitalises every noun, so the following word cannot
          // tell "Der 3. Absatz" from "Wir zählten 20. Dann". What
          // separates them is the determiner or preposition before the
          // number.
          let numberStart = i;
          while (numberStart > 0 && isDigit(text[numberStart - 1])) numberStart--;
          if (rules.ordinalPrefixes.includes(precedingWord(text, numberStart))) {
            continue;
          }
        }
      }

      // A single capital is an initial: "J. Smith", "A. B. Carter".
      if (isUpper(previous) && !isLetter(text[i - 2])) continue;

      // Known abbreviation, including the dotted forms "p.ej", "z.B".
      const word = wordBefore(text, i);
      if (isAbbreviation(word, abbreviations)) continue;
      if (word.includes('.') && isAbbreviation(word.replace(/\.$/, ''), abbreviations)) {
        continue;
      }
    }

    if (!opensSentence(text, next, rules)) continue;

    boundaries.push(withTrailing);
    i = withTrailing - 1;
  }

  // Break positions the user's rules created that no terminator scan
  // would ever visit — a rule can break on anything, not just [.!?…].
  for (const [pos, breakHere] of decided) {
    if (breakHere) boundaries.push(pos);
  }
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (isSpace(text[i])) i++;
  return i;
}

function consumeTrailing(text: string, from: number): number {
  let i = from;
  while (TRAILING.has(text[i] ?? '')) i++;
  return i;
}

/**
 * Whether position `at` could start a new sentence.
 *
 * In Spanish a sentence may open with `¿` or `¡`, so the usual
 * “next character is uppercase” test rejects a real boundary.
 *
 * For non-Latin scripts (Korean, Vietnamese, etc.), any letter character
 * is treated as a valid sentence opener, since these scripts typically don\u2018t
 * have an uppercase/lowercase distinction (backlog #13a).
 */
function opensSentence(text: string, at: number, rules: SegmenterRules): boolean {
  const ch = text[at];
  if (ch === undefined) return false; // end of text is not a boundary
  if (rules.invertedMarks && INVERTED.has(ch)) return true;
  // Uppercase Latin letter or non-Latin letter (no case variant).
  // Korean and Vietnamese: letters that don't change when uppercased.
  if (isUpper(ch) || (isLetter(ch) && ch === ch.toUpperCase())) {
    return true;
  }
  if (isDigit(ch)) return true;
  // An opening quote or bracket followed by an opener.
  if (['"', "'", '\u00ab', '"', '\u2018', '(', '['].includes(ch)) {
    const inner = text[at + 1];
    if (
      isUpper(inner) ||
      isDigit(inner) ||
      (rules.invertedMarks && INVERTED.has(inner ?? '')) ||
      (isLetter(inner) && inner === inner?.toUpperCase())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Splits a tokenized region into sentence-level regions.
 *
 * A tag pair that spans a boundary is closed at the end of one segment and
 * reopened at the start of the next (§3.4), so each resulting segment has
 * a balanced, independently valid tag structure. On export the adjacent
 * identical formatting is re-merged, making the split invisible in the
 * output.
 *
 * Tag ids are renumbered from 1 within each resulting segment, and each
 * gets its own format table.
 */
export function segmentTokens(
  region: TokenizedRegion,
  rules: SegmenterRules,
): TokenizedRegion[] {
  const plain = region.tokens.reduce((s, t) => (t.t === 'text' ? s + t.v : s), '');
  const boundaries = findBoundaries(plain, rules);
  if (boundaries.length === 0) return [region];

  return cutTokensAt(region.tokens, boundaries)
    .filter((tokens) => tokens.some((t) => t.t === 'text' && t.v.trim().length > 0))
    .map((tokens) => renumberRegion(tokens, region.formats));
}

/**
 * Cuts a token stream at ascending plain-text offsets, closing every open
 * tag pair at each cut and reopening it in the next group so both halves
 * stay balanced. Shared by {@link segmentTokens} and the manual split
 * (backlog #14) so an automatic and a manual break behave identically.
 *
 * Groups are returned raw: not renumbered, and possibly without any
 * visible text — callers decide whether to filter or to refuse.
 */
export function cutTokensAt(
  tokens: readonly Token[],
  offsets: readonly number[],
): Token[][] {
  const pending = [...offsets];
  const groups: Token[][] = [];
  let current: Token[] = [];
  // Only open tags are ever pushed; typing it that way lets the
  // reopen below construct valid tokens without a cast.
  const openStack: Array<Extract<Token, { t: 'open' }>> = [];
  let offset = 0;

  /**
   * The split is deferred rather than applied the instant a boundary is
   * reached, because a footnote reference written after a full stop
   * belongs to the sentence it annotates, not to the one that follows.
   * Closing tags likewise close the sentence that just ended.
   */
  let splitPending = false;

  const closeAndReopen = () => {
    // Close every open pair, innermost first, then reopen them in the
    // next segment so both halves are balanced.
    for (let i = openStack.length - 1; i >= 0; i--) {
      current.push({ t: 'close', id: openStack[i]!.id });
    }
    groups.push(current);
    current = openStack.map((t) => ({ ...t }));
    splitPending = false;
  };

  for (const token of tokens) {
    if (token.t !== 'text') {
      // A placeholder or a closing tag trails the sentence just ended; an
      // opening tag starts the next one.
      if (splitPending && token.t === 'open') closeAndReopen();
      current.push(token);
      if (token.t === 'open') openStack.push(token);
      if (token.t === 'close') openStack.pop();
      continue;
    }

    let value = token.v;
    while (pending.length > 0 && pending[0]! <= offset + value.length) {
      const cut = pending.shift()! - offset;
      const head = value.slice(0, cut);
      if (splitPending && head.trim().length > 0) closeAndReopen();
      if (head.length > 0) current.push({ t: 'text', v: head });
      splitPending = true;
      value = value.slice(cut);
      offset += cut;
    }
    if (value.length > 0) {
      if (splitPending && value.trim().length > 0) closeAndReopen();
      current.push({ t: 'text', v: value });
    }
    offset += value.length;
  }
  groups.push(current);
  return groups;
}

/**
 * Renumbers a segment's tag ids from 1 and gives it its own format table.
 *
 * Ids are per-segment by contract (§3.3), so a segment lifted out of a
 * paragraph must not carry the paragraph's numbering with it.
 */
export function renumberRegion(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): TokenizedRegion {
  const source = new Map(formats.map((f) => [f.id, f]));
  const mapped = new Map<number, number>();
  const out: Token[] = [];
  const table: FormatEntry[] = [];

  for (const token of tokens) {
    if (token.t === 'text') {
      out.push(token);
      continue;
    }
    let id = mapped.get(token.id);
    if (id === undefined) {
      id = table.length + 1;
      mapped.set(token.id, id);
      const original = source.get(token.id);
      if (original) table.push({ ...original, id });
    }
    out.push(token.t === 'close' ? { t: 'close', id } : { ...token, id, fmt: id });
  }
  return { tokens: out, formats: table };
}

/** True when every segment produced is independently well-formed. */
export function segmentsAreValid(segments: readonly TokenizedRegion[]): boolean {
  return segments.every((s) => validateTagStructure(s.tokens).ok);
}
