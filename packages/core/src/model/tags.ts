/**
 * Tag invariants.
 *
 * Two rules govern tags in a target segment (planning/v1-spec.md §3.3):
 *
 *  1. `open`/`close` are matched pairs and must nest, never interleave.
 *  2. The target's tag multiset must equal the source's.
 *
 * Tag *order* may differ between source and target — word order changes
 * between languages, and forcing source order would make correct
 * translations unrepresentable. Only nesting validity and multiset
 * equality are enforced.
 */

import type { AnyToken } from './token.js';

export type TagStructureError =
  /** A `close` whose id was never opened. */
  | { readonly code: 'close-without-open'; readonly id: number; readonly index: number }
  /** A `close` that would cross another open pair, e.g. `<1><2></1></2>`. */
  | {
      readonly code: 'interleaved';
      readonly id: number;
      readonly expected: number;
      readonly index: number;
    }
  /** An `open` with no matching `close`. */
  | { readonly code: 'unclosed'; readonly id: number; readonly index: number }
  /** The same tag id opened twice within one segment. */
  | { readonly code: 'duplicate-open'; readonly id: number; readonly index: number }
  /** The same placeholder id used twice within one segment. */
  | { readonly code: 'duplicate-ph'; readonly id: number; readonly index: number };

export type TagStructure =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly TagStructureError[] };

/**
 * Checks that tag pairs are well-formed and properly nested.
 *
 * Reports every problem rather than stopping at the first, so the editor can
 * highlight all of them at once.
 */
export function validateTagStructure(tokens: readonly AnyToken[]): TagStructure {
  const errors: TagStructureError[] = [];
  const stack: number[] = [];
  const opened = new Set<number>();
  const placeholders = new Set<number>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;

    switch (token.t) {
      case 'text':
        break;

      case 'open':
        if (opened.has(token.id)) {
          errors.push({ code: 'duplicate-open', id: token.id, index });
        }
        opened.add(token.id);
        stack.push(token.id);
        break;

      case 'close': {
        const top = stack[stack.length - 1];
        if (top === undefined || !stack.includes(token.id)) {
          errors.push({ code: 'close-without-open', id: token.id, index });
        } else if (top !== token.id) {
          // The id is open, but closing it here would cross another pair.
          errors.push({ code: 'interleaved', id: token.id, expected: top, index });
        } else {
          stack.pop();
        }
        break;
      }

      case 'ph':
        if (placeholders.has(token.id)) {
          errors.push({ code: 'duplicate-ph', id: token.id, index });
        }
        placeholders.add(token.id);
        break;
    }
  }

  // Anything still open at the end was never closed. Report in source order.
  for (const id of stack) {
    const index = tokens.findIndex((t) => t.t === 'open' && t.id === id);
    errors.push({ code: 'unclosed', id, index });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * The multiset of tags in a segment, independent of order.
 *
 * `pairs` holds ids that were opened; `placeholders` holds standalone ids.
 * Both are sorted so signatures compare structurally.
 */
export interface TagSignature {
  readonly pairs: readonly number[];
  readonly placeholders: readonly number[];
}

export function tagSignature(tokens: readonly AnyToken[]): TagSignature {
  const pairs: number[] = [];
  const placeholders: number[] = [];

  for (const token of tokens) {
    if (token.t === 'open') pairs.push(token.id);
    else if (token.t === 'ph') placeholders.push(token.id);
  }

  pairs.sort((a, b) => a - b);
  placeholders.sort((a, b) => a - b);
  return { pairs, placeholders };
}

export function signaturesEqual(a: TagSignature, b: TagSignature): boolean {
  return (
    a.pairs.length === b.pairs.length &&
    a.placeholders.length === b.placeholders.length &&
    a.pairs.every((id, i) => id === b.pairs[i]) &&
    a.placeholders.every((id, i) => id === b.placeholders[i])
  );
}

/** True when target carries exactly the tags source does, in any order. */
export function tagsMatch(
  source: readonly AnyToken[],
  target: readonly AnyToken[],
): boolean {
  return signaturesEqual(tagSignature(source), tagSignature(target));
}

/** Tags present in source but absent from target. Drives QA rule `tag.missing`. */
export function missingTags(
  source: readonly AnyToken[],
  target: readonly AnyToken[],
): TagSignature {
  return difference(tagSignature(source), tagSignature(target));
}

/** Tags present in target but absent from source. Drives QA rule `tag.extra`. */
export function extraTags(
  source: readonly AnyToken[],
  target: readonly AnyToken[],
): TagSignature {
  return difference(tagSignature(target), tagSignature(source));
}

function difference(a: TagSignature, b: TagSignature): TagSignature {
  const bPairs = new Set(b.pairs);
  const bPlaceholders = new Set(b.placeholders);
  return {
    pairs: a.pairs.filter((id) => !bPairs.has(id)),
    placeholders: a.placeholders.filter((id) => !bPlaceholders.has(id)),
  };
}
