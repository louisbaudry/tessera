/**
 * Manual split and merge of segments (planning/v1-spec.md §5.3; backlog #14).
 *
 * The segmenter's bias is deliberately toward *not* breaking on ambiguous
 * punctuation, because a missed break is recoverable and a false one is
 * not. These operations are the recovery: split gives the translator the
 * break the engine declined, merge undoes a break that should never have
 * happened.
 *
 * Both stay within one paragraph. Segments are slices of a paragraph
 * region, so splitting or merging them rearranges slices without touching
 * the skeleton — export still renders the paragraph's segments, in order,
 * into the same marker, which is what keeps the roundtrip gate honest.
 *
 * The invariant both operations preserve: merging a split renders to the
 * same XML as the original segment, byte for byte. Token streams agree up
 * to merge's normal form — adjacent text tokens coalesced, identical
 * adjacent runs fused — which is exactly the collapsing the renderer
 * performs anyway.
 */

import type { FormatEntry, TokenizedRegion } from '../docx/tokenize.js';
import type { SegmentStatus } from '../model/segment.js';
import { validateTagStructure } from '../model/tags.js';
import { plainText, type Token } from '../model/token.js';
import { cutTokensAt, renumberRegion } from './segmenter.js';

export class SegmentEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentEditError';
  }
}

const hasVisibleText = (tokens: readonly Token[]): boolean =>
  tokens.some((t) => t.t === 'text' && t.v.trim().length > 0);

/**
 * Splits one segment into two at a plain-text offset.
 *
 * Uses the same cut machinery as the segmenter, so a manual break behaves
 * exactly like an automatic one: a tag pair spanning the cut is closed and
 * reopened so both halves are balanced, trailing placeholders (a footnote
 * reference after the full stop) stay with the text they annotate, and
 * both halves are renumbered from 1.
 *
 * Refuses an offset that would leave either half without visible text —
 * a segment of pure whitespace is not a segment.
 */
export function splitSegment(
  region: TokenizedRegion,
  offset: number,
): [TokenizedRegion, TokenizedRegion] {
  const length = plainText(region.tokens).length;
  if (!Number.isInteger(offset) || offset <= 0 || offset >= length) {
    throw new SegmentEditError(
      `split offset ${offset} is outside the segment's interior (0, ${length})`,
    );
  }
  const groups = cutTokensAt(region.tokens, [offset]);
  if (groups.length !== 2 || !hasVisibleText(groups[0]!) || !hasVisibleText(groups[1]!)) {
    throw new SegmentEditError('a split must leave visible text on both sides');
  }
  return [
    renumberRegion(groups[0]!, region.formats),
    renumberRegion(groups[1]!, region.formats),
  ];
}

/** Format equality, ignoring the id — the payload is what matters. */
const sameFormat = (a: FormatEntry | undefined, b: FormatEntry | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.kind === b.kind &&
  a.visible === b.visible &&
  a.placement === b.placement &&
  a.open === b.open &&
  a.close === b.close;

/**
 * Joins adjacent text tokens. The boundary between two text tokens is an
 * extraction artifact — several `w:t` in one run, or a cut a split made —
 * with no linguistic or formatting meaning: rendering re-merges the runs
 * and the plain text is identical. A merged segment is a new segment, so
 * it is emitted in this normal form; that is also what makes
 * split-then-merge an exact identity.
 */
export function coalesceTextTokens(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (token.t === 'text' && last?.t === 'text') {
      out[out.length - 1] = { t: 'text', v: last.v + token.v };
    } else {
      out.push(token);
    }
  }
  return out;
}

export interface MergeOptions {
  /**
   * Inserted between the two halves when neither already provides
   * boundary whitespace. Targets usually need `' '` — the inter-sentence
   * space of the source lives in the source stream, not in the targets a
   * translator typed. Sources merge without one: their whitespace is
   * already in the tokens, and inventing more would break the
   * split-then-merge identity.
   */
  readonly separator?: string;
}

/**
 * Merges two adjacent segments into one.
 *
 * A pair that a split closed at the seam and reopened on the other side
 * is fused back into a single spanning pair (matching outermost-in, by
 * format payload), so merging a split restores the original structure.
 * Two *distinct* adjacent pairs with identical payload also fuse — the
 * seam cannot tell them from a split pair, and need not: the renderer
 * collapses identical adjacent runs the same way, so the exported XML is
 * unchanged. Pairs that genuinely differ stay as they are.
 */
export function mergeSegments(
  a: TokenizedRegion,
  b: TokenizedRegion,
  options: MergeOptions = {},
): TokenizedRegion {
  // Shift b's ids past a's so the two tables can coexist.
  const shift = Math.max(
    0,
    ...a.formats.map((f) => f.id),
    ...a.tokens.map((t) => (t.t === 'text' ? 0 : t.id)),
  );
  const bTokens: Token[] = b.tokens.map((t) =>
    t.t === 'text'
      ? t
      : t.t === 'close'
        ? { t: 'close', id: t.id + shift }
        : { ...t, id: t.id + shift, fmt: t.fmt + shift },
  );
  const bFormats = b.formats.map((f) => ({ ...f, id: f.id + shift }));

  // The seam: a's trailing run of closes (outermost last) against b's
  // leading run of opens (outermost first). Fuse outermost-in while the
  // format payloads match.
  let closeRun = 0;
  while (
    closeRun < a.tokens.length &&
    a.tokens[a.tokens.length - 1 - closeRun]!.t === 'close'
  ) {
    closeRun++;
  }
  let openRun = 0;
  while (openRun < bTokens.length && bTokens[openRun]!.t === 'open') openRun++;

  const aFormat = new Map(a.formats.map((f) => [f.id, f]));
  const bFormat = new Map(bFormats.map((f) => [f.id, f]));
  const remap = new Map<number, number>();
  let fused = 0;
  while (fused < closeRun && fused < openRun) {
    const close = a.tokens[a.tokens.length - 1 - fused] as { t: 'close'; id: number };
    const open = bTokens[fused] as { t: 'open'; id: number; fmt: number };
    if (!sameFormat(aFormat.get(close.id), bFormat.get(open.id))) break;
    remap.set(open.id, close.id);
    fused++;
  }

  const head = a.tokens.slice(0, a.tokens.length - fused);
  const tail = bTokens
    .slice(fused)
    .map((t): Token =>
      t.t === 'close' && remap.has(t.id) ? { t: 'close', id: remap.get(t.id)! } : t,
    );

  const merged: Token[] = [...head];
  const separator = options.separator ?? '';
  if (
    separator.length > 0 &&
    !/\s$/.test(plainText(a.tokens)) &&
    !/^\s/.test(plainText(b.tokens))
  ) {
    merged.push({ t: 'text', v: separator });
  }
  merged.push(...tail);

  const region = renumberRegion(coalesceTextTokens(merged), [...a.formats, ...bFormats]);
  const check = validateTagStructure(region.tokens);
  if (!check.ok) {
    // Both inputs were balanced, so this indicates a malformed input
    // region rather than a fusion bug — refuse rather than emit it.
    throw new SegmentEditError('merge would produce an invalid tag structure');
  }
  return region;
}

/**
 * The editing layer's view of a segment: what split and merge need to
 * know, without the storage row around it. The store maps its rows into
 * this shape and writes the results back (origin becomes null — a manual
 * edit is not a TM hit any more).
 */
export interface EditableSegment {
  readonly source: TokenizedRegion;
  readonly target: TokenizedRegion | null;
  readonly status: SegmentStatus;
  readonly locked: boolean;
}

const assertEditable = (segment: EditableSegment, verb: string): void => {
  if (segment.locked || segment.status === 'locked') {
    throw new SegmentEditError(`a locked segment cannot be ${verb}`);
  }
};

/**
 * Splits a segment, deciding what happens to its target and status.
 *
 * The target is not split: language pairs do not align by character
 * offset, so any mechanical cut of the translation would be wrong more
 * often than right. It stays whole on the first half for the translator
 * to redistribute, and that half becomes a draft; the second half starts
 * empty. A confirmed segment may be split, but neither half stays
 * confirmed — the source it was confirmed against no longer exists.
 */
export function splitEditableSegment(
  segment: EditableSegment,
  offset: number,
): [EditableSegment, EditableSegment] {
  assertEditable(segment, 'split');
  const [first, second] = splitSegment(segment.source, offset);
  return [
    {
      source: first,
      target: segment.target,
      status: segment.target ? 'draft' : 'new',
      locked: false,
    },
    { source: second, target: null, status: 'new', locked: false },
  ];
}

/**
 * Merges two adjacent segments, preserving whatever targets exist.
 *
 * Two targets are joined with a space (their sources' inter-sentence
 * whitespace lives in the source stream, not in what the translator
 * typed); a single target is kept as-is. Either way the result is a
 * draft — it has never been reviewed in its merged form. With no targets
 * the merge is just a wider untranslated segment.
 */
export function mergeEditableSegments(
  a: EditableSegment,
  b: EditableSegment,
): EditableSegment {
  assertEditable(a, 'merged');
  assertEditable(b, 'merged');
  const source = mergeSegments(a.source, b.source);
  const target =
    a.target && b.target
      ? mergeSegments(a.target, b.target, { separator: ' ' })
      : (a.target ?? b.target);
  return { source, target, status: target ? 'draft' : 'new', locked: false };
}
