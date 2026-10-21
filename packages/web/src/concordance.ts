/**
 * Concordance search in the editor (`v1-spec.md` §6.1b; issue #170): what the
 * box starts with, how a hit's text is cut around the words that matched, how
 * the result is summed up, and which key opens it. Pure, so each is provable in
 * node; `ConcordanceDialog.tsx` renders and `Grid.tsx` reads the selection and
 * says what the key does.
 *
 * The words, the phrase and the offsets of a match are `core`'s, computed by the
 * server (`core/tm/concordance.ts`): this module holds no tokenizer, only the
 * ranges it is given.
 */
import type { ConcordanceSide, TextRange } from '@cat-tool/core';

import { cleanSelection } from './add-term.js';

/** One unit holding the phrase, as `GET /api/projects/:name/concordance` sends it. */
export interface ConcordanceHitView {
  readonly tuId: number;
  /** Position of the memory in the project's priority order, from 1. */
  readonly memory: number;
  /** What an edit names: the project's own memory reference, the variant and its revision. */
  readonly ref: number;
  readonly tuvId: number;
  readonly rev: number;
  /** Whether the translation is text only, so an edit cannot lose a tag. */
  readonly editable: boolean;
  readonly source: string;
  readonly target: string;
  /** Where the phrase sits in the searched side's text. */
  readonly ranges: readonly TextRange[];
  readonly updatedAt: string;
}

export interface ConcordanceView {
  readonly hits: readonly ConcordanceHitView[];
  readonly more: boolean;
  /** How many enabled memories were searched; 0 means none are attached. */
  readonly searched: number;
}

/** A selection longer than a lookup is not put in the box. */
export const MAX_QUERY_CHARS = 120;

/** What the box starts with: the selected text and the side it was selected in. */
export interface ConcordanceStart {
  readonly side: ConcordanceSide;
  readonly text: string;
}

/**
 * The box for a selection: the text on the side it was selected in, so a word
 * picked in the source is looked up in the source memory and one picked in the
 * target in the target. No selection, or one too long to be a lookup, opens an
 * empty box on the source side.
 */
export function startFromSelection(
  picked: { side: ConcordanceSide; text: string } | null,
): ConcordanceStart {
  if (picked === null) return { side: 'source', text: '' };
  const text = cleanSelection(picked.text);
  if (text === '' || text.length > MAX_QUERY_CHARS) return { side: 'source', text: '' };
  return { side: picked.side, text };
}

/** A piece of a hit's text, and whether it is part of the match. */
export interface Piece {
  readonly text: string;
  readonly hit: boolean;
}

/**
 * The text cut at the ranges, in order: the pieces between and around them are
 * not hits, the ranges are. Ranges are clamped and anything out of order or
 * overlapping is dropped, so a bad range from a server can cost a highlight and
 * never text.
 */
export function pieces(text: string, ranges: readonly TextRange[]): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, at);
    const end = Math.min(range.end, text.length);
    if (start >= end) continue;
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The line above the results. */
export function summary(result: ConcordanceView): string {
  if (result.searched === 0) return 'No memory is attached to this project.';
  const n = result.hits.length;
  if (n === 0) return 'No match.';
  const matches = `${n} ${n === 1 ? 'match' : 'matches'}`;
  return result.more
    ? `${matches} shown, newest first. There are more.`
    : `${matches}, newest first.`;
}

/** Whether a key event is the concordance key: Ctrl+Shift+L, literal Ctrl on every platform. */
export function isConcordanceKey(e: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly code: string;
}): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyL';
}

/** Why an edited translation cannot be saved yet, or null when it can. */
export function editProblem(draft: string, current: string): string | null {
  const text = cleanSelection(draft);
  if (text === '') return 'Type the translation.';
  if (text === cleanSelection(current)) return 'The translation is unchanged.';
  return null;
}

/**
 * What to tell a person whose write was refused. A 409 is a unit changed since it was
 * searched (or a memory marked read-only, which the server's own words say), and the
 * answer is to look again; anything else keeps the server's words.
 */
export function refusal(status: number, message: string): string {
  return status === 409 ? `${message}. Search again, then retry.` : message;
}

/** The line shown after a write: what happened, and that the list below is fresh. */
export function doneNote(kind: 'edit' | 'retire', changed: boolean): string {
  if (kind === 'edit')
    return changed ? 'Translation saved.' : 'Nothing to save: it was already so.';
  return changed ? 'Unit retired.' : 'That unit was already retired.';
}
