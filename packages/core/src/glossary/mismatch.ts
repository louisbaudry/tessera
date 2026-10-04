/**
 * Glossary mismatches (smart-glossary-spec.md §6, §6.1; backlog #43c): the
 * segments whose target does not use the rendering a glossary prefers, or
 * uses one it forbids. Pure — entries and segments in, rows out — so every
 * rule is provable from strings. Soft by design (§6): a mismatch is
 * information for the translator, never a QA finding and never an error.
 */

import type { Segment } from '../model/segment.js';
import { plainText, type AnyToken } from '../model/token.js';
import { inflectionEndings } from './inflection.js';
import { termKey } from './key.js';

/** One rendering of a term, as text and as `termKey`. */
export interface EntryForm {
  readonly text: string;
  readonly plain: string;
}

/** What a glossary says about one term in one language pair. */
export interface GlossaryTermEntry {
  readonly termId: number;
  /** Source-language forms (non-forbidden): any of them in the source makes the term present. */
  readonly source: readonly EntryForm[];
  /** The derived preferred target rendering; null when only forbidden ones exist. */
  readonly preferred: EntryForm | null;
  /** Other acceptable target renderings. */
  readonly alternatives: readonly EntryForm[];
  /** Target renderings the client rejected. */
  readonly forbidden: readonly EntryForm[];
}

export const MISMATCH_KINDS = ['forbidden', 'missing_preferred'] as const;
export type MismatchKind = (typeof MISMATCH_KINDS)[number];

export interface GlossaryMismatch {
  readonly ord: number;
  readonly segmentId: number;
  readonly termId: number;
  /** The source form that matched. */
  readonly term: string;
  readonly kind: MismatchKind;
  /** The preferred rendering as text; null if the entry has none. */
  readonly preferred: string | null;
  /** The forbidden text found, or another acceptable rendering used instead; else null. */
  readonly found: string | null;
}

export interface MismatchLangs {
  readonly srcLang: string;
  readonly tgtLang: string;
}

type Span = readonly [start: number, end: number];

const WORD_CHAR_AT_END = /[\p{L}\p{N}]$/u;
const startsWithWordChar = (s: string): boolean => /^[\p{L}\p{N}]/u.test(s);

/**
 * Every occurrence of `needle` in `haystack` (both already `termKey`ed)
 * that starts at a word boundary and ends at one, allowing one of
 * `endings` after the last word. A span includes the ending.
 */
export function wordSpans(
  haystack: string,
  needle: string,
  endings: readonly string[],
): Span[] {
  const spans: Span[] = [];
  if (needle === '') return spans;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return spans;
    from = at + 1;
    if (WORD_CHAR_AT_END.test(haystack.slice(0, at))) continue;
    const after = at + needle.length;
    const rest = haystack.slice(after);
    if (!startsWithWordChar(rest)) {
      spans.push([at, after]);
      continue;
    }
    for (const ending of endings) {
      if (!rest.startsWith(ending)) continue;
      if (!startsWithWordChar(rest.slice(ending.length))) {
        spans.push([at, after + ending.length]);
        break;
      }
    }
  }
}

const WORDS = /[\p{L}\p{N}]+/gu;

/**
 * Which entries can possibly match a source text, without searching it
 * once per entry (10,000 segments against 500 entries is five million
 * searches, 1.1 s measured). A form occurs only if its first word does, so
 * entries are indexed by first word; a source word is looked up as written
 * and with each ending taken off (the ending is tolerated on a term's last
 * word, which for a one-word term is its first). A form with no word in it
 * is a candidate everywhere. The index only narrows: `wordSpans` still
 * decides, and the candidates come back in entry order.
 */
function candidateFinder(
  entries: readonly GlossaryTermEntry[],
  endings: readonly string[],
): (source: string) => GlossaryTermEntry[] {
  const byFirstWord = new Map<string, number[]>();
  const everywhere: number[] = [];
  entries.forEach((entry, i) => {
    for (const form of entry.source) {
      const first = form.plain.match(WORDS)?.[0];
      if (first === undefined) everywhere.push(i);
      else byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), i]);
    }
  });
  return (source) => {
    const hit = new Set<number>(everywhere);
    for (const word of source.match(WORDS) ?? []) {
      for (const w of [
        word,
        ...endings.filter((e) => word.endsWith(e)).map((e) => word.slice(0, -e.length)),
      ]) {
        for (const i of byFirstWord.get(w) ?? []) hit.add(i);
      }
    }
    return [...hit].sort((a, b) => a - b).map((i) => entries[i]!);
  };
}

const inside = (inner: Span, outer: Span): boolean =>
  outer[0] <= inner[0] && inner[1] <= outer[1];

/** A mismatch before it is placed in a file: what one source/target pair says. */
export type SegmentMismatch = Omit<GlossaryMismatch, 'ord' | 'segmentId'>;

/** The mismatches in one source/target pair (a {@link mismatchFinder}). */
export type MismatchFinder = (
  source: readonly AnyToken[],
  target: readonly AnyToken[] | null,
) => SegmentMismatch[];

/**
 * A finder over `entries`, built once and applied to as many segments as
 * a pass has (the first-word index is the cost worth sharing, see
 * {@link candidateFinder}). A pair with no target, or a target with no
 * text, has none: it is untranslated, which `qa` says. Per term at most
 * one row — `forbidden` if a forbidden rendering occurs outside any
 * acceptable one, else `missing_preferred` if the preferred is absent —
 * in entry order.
 */
export function mismatchFinder(
  entries: readonly GlossaryTermEntry[],
  langs: MismatchLangs,
): MismatchFinder {
  const srcEndings = inflectionEndings(langs.srcLang);
  const tgtEndings = inflectionEndings(langs.tgtLang);
  const candidatesIn = candidateFinder(entries, srcEndings);

  return (sourceTokens, targetTokens) => {
    if (targetTokens === null) return [];
    const target = termKey(plainText(targetTokens));
    if (target === '') return [];
    const source = termKey(plainText(sourceTokens));
    const out: SegmentMismatch[] = [];

    for (const entry of candidatesIn(source)) {
      const matched = entry.source.find(
        (form) => wordSpans(source, form.plain, srcEndings).length > 0,
      );
      if (!matched) continue;

      const acceptable = [entry.preferred, ...entry.alternatives].filter(
        (f): f is EntryForm => f !== null,
      );
      const acceptableSpans = acceptable.flatMap((f) =>
        wordSpans(target, f.plain, tgtEndings),
      );

      const base = {
        termId: entry.termId,
        term: matched.text,
        preferred: entry.preferred?.text ?? null,
      };

      const forbiddenHit = entry.forbidden.find((f) =>
        wordSpans(target, f.plain, tgtEndings).some(
          (span) => !acceptableSpans.some((outer) => inside(span, outer)),
        ),
      );
      if (forbiddenHit) {
        out.push({ ...base, kind: 'forbidden', found: forbiddenHit.text });
        continue;
      }

      if (entry.preferred === null) continue;
      if (wordSpans(target, entry.preferred.plain, tgtEndings).length > 0) continue;
      const used = entry.alternatives.find(
        (f) => wordSpans(target, f.plain, tgtEndings).length > 0,
      );
      out.push({ ...base, kind: 'missing_preferred', found: used?.text ?? null });
    }
    return out;
  };
}

/**
 * The mismatches in `segments` against `entries`, in segment order, then
 * entry order (see {@link mismatchFinder} for what counts).
 */
export function findMismatches(
  entries: readonly GlossaryTermEntry[],
  segments: readonly Segment[],
  langs: MismatchLangs,
): GlossaryMismatch[] {
  const find = mismatchFinder(entries, langs);
  return segments.flatMap((segment) =>
    find(segment.sourceTokens, segment.targetTokens).map((m) => ({
      ord: segment.ord,
      segmentId: segment.id,
      ...m,
    })),
  );
}
