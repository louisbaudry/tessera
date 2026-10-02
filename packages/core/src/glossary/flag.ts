/**
 * Stage 3 of detection: which candidates are worth the translator's
 * attention (smart-glossary-spec.md §4.3, backlog #40). Deterministic
 * again — candidates, what the aligner said and what the glossary holds
 * in, flags out — so the aim, a panel with the five decisions worth
 * making and not fifty, is a property of a pure function.
 */

import type { Candidate } from './candidates.js';
import { termKey } from './key.js';
import type { AlignResult, Rendering } from './align.js';
import type { SessionFlag } from './session.js';

/** What the glossary already says about a source term (§6: soft, never enforced). */
export interface GlossaryEntry {
  readonly termId: number;
  /** The preferred rendering in the target language, as text; null when none is decided yet. */
  readonly preferred: string | null;
}

/** The glossary as detection sees it: a source term's `termKey` to its entry, or null. */
export type GlossaryLookup = (key: string) => GlossaryEntry | null;

export const FLAG_REASONS = [
  /** Two or more distinct renderings. */
  'inconsistent',
  /** One rendering, but the aligner is not sure of it. */
  'uncertain',
  /** The glossary prefers a rendering that some segment does not use. */
  'glossary_mismatch',
  /** Stage 2 did not run: repeated and undecided, nothing known of its renderings. */
  'unaligned',
] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export interface TermFlag {
  readonly key: string;
  readonly term: string;
  readonly occurrences: number;
  readonly ords: readonly number[];
  /** Why it was flagged; never empty. */
  readonly reasons: readonly FlagReason[];
  /** The renderings found, merged under `termKey`, most-used first. */
  readonly renderings: readonly Rendering[];
  /** The glossary entry it is about, or null for a term it lacks. */
  readonly entry: GlossaryEntry | null;
}

export interface FlagOptions {
  /** A single rendering below this confidence is flagged `uncertain`. Default 0.7. */
  readonly minConfidence?: number;
}

export const DEFAULT_MIN_CONFIDENCE = 0.7;

/**
 * Renderings that are the same string under `termKey` are one rendering:
 * `Factura` and `factura` are not an inconsistency. Their segments are
 * united and the aligner's confidence is the highest it gave either, the
 * display text the one used in more segments. Most-used first, then
 * higher confidence, then by key, so a flag reads the same every run.
 */
function mergeRenderings(renderings: readonly Rendering[]): Rendering[] {
  const merged = new Map<
    string,
    { best: Rendering; ords: Set<number>; confidence: number }
  >();
  for (const r of renderings) {
    const key = termKey(r.text);
    const m = merged.get(key);
    if (!m) {
      merged.set(key, { best: r, ords: new Set(r.ords), confidence: r.confidence });
      continue;
    }
    if (r.ords.length > m.best.ords.length) m.best = r;
    for (const o of r.ords) m.ords.add(o);
    m.confidence = Math.max(m.confidence, r.confidence);
  }
  return [...merged]
    .map(([key, m]) => ({
      key,
      rendering: {
        text: m.best.text,
        ords: [...m.ords].sort((a, b) => a - b),
        confidence: m.confidence,
      },
    }))
    .sort(
      (a, b) =>
        b.rendering.ords.length - a.rendering.ords.length ||
        b.rendering.confidence - a.rendering.confidence ||
        a.key.localeCompare(b.key),
    )
    .map((x) => x.rendering);
}

/**
 * `flagTerms(candidates, alignments, glossary)` — the candidates worth
 * deciding. `alignments` is what the aligner said, by candidate `key`;
 * `null` means Stage 2 did not run (the client has AI off, §4.2).
 *
 * With alignments, a candidate is flagged when any of:
 *
 * - it has two or more distinct renderings (`inconsistent`);
 * - it has one, and its confidence is under `minConfidence` (`uncertain`);
 * - the glossary has a preferred rendering and some rendering differs from
 *   it (`glossary_mismatch`: decision 5's "highlight", never an error).
 *
 * Not flagged: one consistent, confident rendering that matches the
 * glossary or has no entry; and a candidate the aligner found no
 * rendering for (a key absent from the map), since there is nothing to
 * decide between.
 *
 * Without them, every candidate the glossary has no decided rendering for
 * is flagged `unaligned`: repeated and undecided are decision 1's two
 * halves, and "this term repeats 11 times, decide it once" is still
 * useful with no renderings to offer (§4.2). One that already has a
 * preferred rendering is not asked again.
 *
 * Order follows `candidates`.
 */
export function flagTerms(
  candidates: readonly Candidate[],
  alignments: ReadonlyMap<string, AlignResult> | null,
  glossary: GlossaryLookup,
  options: FlagOptions = {},
): TermFlag[] {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const out: TermFlag[] = [];
  for (const c of candidates) {
    const entry = glossary(c.key);
    const base = {
      key: c.key,
      term: c.term,
      occurrences: c.occurrences,
      ords: c.ords,
      entry,
    };
    if (alignments === null) {
      if (entry?.preferred != null) continue;
      out.push({ ...base, reasons: ['unaligned'], renderings: [] });
      continue;
    }
    const renderings = mergeRenderings(alignments.get(c.key)?.renderings ?? []);
    const reasons: FlagReason[] = [];
    if (renderings.length >= 2) reasons.push('inconsistent');
    else if (renderings.length === 1 && renderings[0]!.confidence < minConfidence) {
      reasons.push('uncertain');
    }
    if (entry?.preferred != null) {
      const preferred = termKey(entry.preferred);
      if (renderings.some((r) => termKey(r.text) !== preferred)) {
        reasons.push('glossary_mismatch');
      }
    }
    if (reasons.length > 0) out.push({ ...base, reasons, renderings });
  }
  return out;
}

/**
 * A flag as the session takes it (§5, `SessionFlag`): the renderings on
 * offer as text, in the order `flagTerms` ranked them — with the
 * glossary's preferred one, if the aligner did not find it, added last so
 * the translator can still go back to it — and where the term first
 * occurs. Neither side depends on the other; this is the one place they
 * meet.
 */
export function toSessionFlag(flag: TermFlag): SessionFlag {
  const offered = flag.renderings.map((r) => r.text);
  const preferred = flag.entry?.preferred;
  if (preferred != null && !offered.some((t) => termKey(t) === termKey(preferred))) {
    offered.push(preferred);
  }
  return {
    key: flag.key,
    term: flag.term,
    termId: flag.entry?.termId ?? null,
    offered,
    firstOrd: flag.ords.length > 0 ? flag.ords[0]! : null,
  };
}
