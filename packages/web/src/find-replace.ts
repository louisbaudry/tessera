/**
 * Find and replace in the editor (`v1-spec.md` §7.8; backlog #148b, issue #170): the
 * jobs as the API describes them, what each state says, which segments are ticked and
 * what is sent for them, and which key opens the box. Pure, so each is provable in
 * node; `FindReplaceDialog.tsx` renders and polls, and `Grid.tsx` says what the key does.
 *
 * The pattern, the matching and the replacement are the server's (`core/project/
 * find-replace.ts`, on a thread with a time limit): the page only sends text and shows
 * what came back, and holds no regular expression engine of its own.
 */
import type { TextRange } from '@cat-tool/core';

/** One segment a run would change, as the preview job returns it. */
export interface ReplaceProposalView {
  readonly segmentId: number;
  readonly fileId: number;
  readonly ord: number;
  /** The segment's version in the preview: an apply names it, and a changed one is skipped. */
  readonly updatedAt: string;
  readonly status: string;
  readonly before: string;
  readonly after: string;
  /** Where the matches sit in `before`. */
  readonly ranges: readonly TextRange[];
  readonly count: number;
}

export interface ReplaceScanResult {
  readonly proposals: readonly ReplaceProposalView[];
  readonly scanned: number;
  readonly locked: number;
  readonly truncated: boolean;
}

export interface ReplaceApplyResult {
  readonly segments: number;
  readonly matches: number;
  readonly stale: number;
  readonly locked: number;
  readonly unchanged: number;
  readonly batchId: number | null;
}

/** A find-and-replace job, as `GET /api/jobs/:id` returns it. */
export interface ReplaceJob<R> {
  readonly id: string;
  readonly kind: 'replace';
  /** The project being searched. */
  readonly tm: string;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  readonly progress: {
    readonly stage: string;
    readonly fraction: number | null;
    readonly units: number | null;
  } | null;
  readonly result: R | null;
  readonly error: string | null;
}

export const isFinished = (job: ReplaceJob<unknown>): boolean => job.state !== 'running';

/** What is asked: the text to find and what to put there, and how to read the first. */
export interface ReplaceForm {
  readonly pattern: string;
  readonly replacement: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
}

export const EMPTY_FORM: ReplaceForm = {
  pattern: '',
  replacement: '',
  regex: false,
  caseSensitive: false,
};

const n = (value: number): string => value.toLocaleString('en');
const plural = (count: number, one: string, many: string): string =>
  `${n(count)} ${count === 1 ? one : many}`;

/** One line for a job, whatever state it is in. */
export function describeJob(
  job: ReplaceJob<unknown>,
  verb: 'search' | 'replace',
): string {
  switch (job.state) {
    case 'running': {
      const p = job.progress;
      const word = verb === 'search' ? 'Searching' : 'Replacing';
      const pct =
        p?.fraction === null || p?.fraction === undefined || Number.isNaN(p.fraction)
          ? null
          : Math.max(0, Math.min(100, Math.floor(p.fraction * 100)));
      return pct === null ? `${word}…` : `${word}… ${pct}%`;
    }
    case 'cancelled':
      return verb === 'search'
        ? 'Search cancelled.'
        : 'Replace cancelled: nothing was changed.';
    case 'failed':
      return (
        job.error ?? (verb === 'search' ? 'The search failed.' : 'The replace failed.')
      );
    case 'done':
      return 'Done.';
  }
}

/** What a finished preview says. A cap is said, never silent. */
export function scanSummary(result: ReplaceScanResult): string {
  const total = result.proposals.reduce((sum, p) => sum + p.count, 0);
  if (result.proposals.length === 0) {
    return result.locked > 0
      ? `No segment matches. ${plural(result.locked, 'locked segment was', 'locked segments were')} not searched.`
      : 'No segment matches.';
  }
  const head = `${plural(result.proposals.length, 'segment', 'segments')} would change (${plural(total, 'match', 'matches')}).`;
  return result.truncated
    ? `${head} More segments match than one run takes: these are the first ones. Run it again for the rest.`
    : head;
}

/** What a finished apply says: what was written, and what was left alone and why. */
export function applySummary(result: ReplaceApplyResult): string {
  const skipped: string[] = [];
  if (result.stale > 0) {
    skipped.push(
      `${plural(result.stale, 'segment', 'segments')} changed since the preview`,
    );
  }
  if (result.locked > 0)
    skipped.push(`${plural(result.locked, 'segment', 'segments')} locked`);
  if (result.unchanged > 0) {
    skipped.push(
      `${plural(result.unchanged, 'segment', 'segments')} the replacement left as it was`,
    );
  }
  const left = skipped.length > 0 ? ` Left alone: ${skipped.join(', ')}.` : '';
  if (result.segments === 0) return `Nothing was replaced.${left}`;
  return `Replaced ${plural(result.matches, 'match', 'matches')} in ${plural(result.segments, 'segment', 'segments')}. They are translated again and need confirming.${left}`;
}

/** Every segment of a preview ticked: the box starts as "replace everywhere". */
export function allTicked(
  proposals: readonly ReplaceProposalView[],
): ReadonlySet<number> {
  return new Set(proposals.map((p) => p.segmentId));
}

/** `ticked` with one segment turned on or off. */
export function toggled(
  ticked: ReadonlySet<number>,
  segmentId: number,
): ReadonlySet<number> {
  const next = new Set(ticked);
  if (!next.delete(segmentId)) next.add(segmentId);
  return next;
}

/** What an apply is sent for the ticked segments, in the preview's order, with the version each had. */
export function chosenFor(
  proposals: readonly ReplaceProposalView[],
  ticked: ReadonlySet<number>,
): Array<{ segmentId: number; updatedAt: string }> {
  return proposals
    .filter((p) => ticked.has(p.segmentId))
    .map((p) => ({ segmentId: p.segmentId, updatedAt: p.updatedAt }));
}

/** Why the form cannot be sent yet, or null. The server checks the rest (the pattern's validity). */
export function formProblem(form: ReplaceForm): string | null {
  return form.pattern === '' ? 'Type what to find.' : null;
}

/** The label on the apply button for how many segments are ticked. */
export function applyLabel(count: number): string {
  return count === 1 ? 'Replace in 1 segment' : `Replace in ${n(count)} segments`;
}

/** Whether a key event is the find-and-replace key: Ctrl+Shift+H, literal Ctrl on every platform. */
export function isReplaceKey(e: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly code: string;
}): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyH';
}
