/**
 * The shape of a segmentation corpus case (issue #267, `segmentation-spec.md`
 * §9). Test scaffolding: the build excludes `*.fixture.ts`.
 *
 * A corpus is organised by *category of difficulty*, not by source, so a gap
 * reads as "closing quotes after a full stop" and not as "case 41". The idea
 * of a golden-rules set organised that way is pySBD's and pragmatic_segmenter's
 * (both MIT; `planning/prior-art.md`); every sentence here is written for
 * Tessera and none is copied from either.
 */

/** What makes a text hard to segment. One per case, so a gap names its cause. */
export type Category =
  | 'plain terminators'
  | 'ellipsis and runs of marks'
  | 'quotes and brackets'
  | 'abbreviations'
  | 'abbreviation at a sentence end'
  | 'initials and acronyms'
  | 'numbers and decimals'
  | 'ordinals and dates'
  | 'numbered steps'
  | 'urls, emails and file names'
  | 'lowercase starts'
  | 'whitespace'
  | 'inverted marks'
  | 'typographic spacing'
  | 'scripts without case';

/**
 * How a case relates to the segmenter as it is today.
 *
 * - `correct` (the default, no status field): the sentences are what a
 *   translator should get, and the segmenter gives them.
 * - `policy`: the segmenter does something on purpose that a reader might
 *   question, and `sentences` is that behaviour. The note says why. The usual
 *   reason: a false break poisons the memory with a fragment that never
 *   matches again, while a missed break only makes a longer segment.
 * - `gap`: the segmenter is wrong. `sentences` is what the translator should
 *   get; the test asserts the segmenter still *differs*, so closing the gap
 *   fails the run until the case is promoted by deleting its status.
 */
export type CaseStatus = 'policy' | 'gap';

export interface CorpusCase {
  readonly category: Category;
  readonly text: string;
  /** Sentences in order, trimmed, as `findBoundaries` should cut them. */
  readonly sentences: readonly string[];
  readonly status?: CaseStatus;
  /** Required for `policy` and `gap`: the reason, or what goes wrong. */
  readonly note?: string;
  /** For a `gap`: the issue that tracks it. */
  readonly issue?: number;
}
