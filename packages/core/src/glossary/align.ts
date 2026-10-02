/**
 * Stage 2 of detection: how the target renders a candidate
 * (smart-glossary-spec.md §4.2, backlog #40). Honest alignment across two
 * languages is a model's job, so it sits behind an interface, the way
 * `NotificationService` and `ProductionAdapter` do in `portal-core`:
 * `core` fixes the contract and ships only `StaticTermAligner`, a lookup
 * table with no I/O. The Claude-backed one is backlog #42, in the server,
 * because it is HTTP.
 */

import { normalizeText } from '../tm/normalize.js';
import type { Segment } from '../model/segment.js';
import { plainText } from '../model/token.js';
import type { Candidate } from './candidates.js';
import { termKey } from './key.js';

export interface AlignRequest {
  readonly srcLang: string;
  readonly tgtLang: string;
  /** The candidate, source-language, as written. */
  readonly term: string;
  readonly pairs: readonly {
    readonly ord: number;
    readonly source: string;
    readonly target: string;
  }[];
}

/** One way the target renders the term. */
export interface Rendering {
  /** As found in the target. */
  readonly text: string;
  /** Segments that render it this way. */
  readonly ords: readonly number[];
  /** 0..1, the aligner's own. */
  readonly confidence: number;
}

export interface AlignResult {
  readonly renderings: readonly Rendering[];
}

export interface TermAligner {
  align(request: AlignRequest): Promise<AlignResult>;
}

/**
 * The request for one candidate: its segments, source and target as
 * plain text. A segment with no target yet is left out — there is
 * nothing in it to align, and detection runs over a finished draft
 * (decision 10).
 */
export function alignRequestFor(
  candidate: Candidate,
  segments: readonly Segment[],
  langs: { readonly srcLang: string; readonly tgtLang: string },
): AlignRequest {
  const wanted = new Set(candidate.ords);
  const pairs = segments
    .filter((s) => wanted.has(s.ord) && s.targetTokens !== null)
    .map((s) => ({
      ord: s.ord,
      source: normalizeText(plainText(s.sourceTokens)),
      target: normalizeText(plainText(s.targetTokens!)),
    }));
  return { ...langs, term: candidate.term, pairs };
}

/**
 * A lookup table, for tests: the renderings to answer for a term, by its
 * `termKey`. A term not in the table has none, which is what an aligner
 * that found nothing says. Every request it was asked is kept in
 * `requests`, so a test can assert what was — and was not — asked.
 */
export class StaticTermAligner implements TermAligner {
  readonly requests: AlignRequest[] = [];
  private readonly table: ReadonlyMap<string, readonly Rendering[]>;

  constructor(table: Readonly<Record<string, readonly Rendering[]>>) {
    this.table = new Map(Object.entries(table).map(([term, r]) => [termKey(term), r]));
  }

  async align(request: AlignRequest): Promise<AlignResult> {
    this.requests.push(request);
    return { renderings: this.table.get(termKey(request.term)) ?? [] };
  }
}
