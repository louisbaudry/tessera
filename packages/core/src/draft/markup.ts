/**
 * The placeholder markup a draft engine sees (`planning/translation-engine-spec.md`
 * §3 step 5; backlog #134).
 *
 * A source's visible inline tags become `<t1>…</t1>` (a pair) and `<t2/>` (a
 * standalone tag), numbered from 1 in the order they first appear — never the
 * file's own ids, which mean nothing outside it and would make two identical
 * sentences from two files hash to different prompts. Text is escaped
 * (`&`, `<`, `>`), so a literal angle bracket in a segment or in a memory
 * unit can never read as a marker, nor close a block of the prompt it sits in.
 *
 * Hidden tags have no marker: they are the document's, never the engine's to
 * place, and `carryHiddenTags` puts them back when a draft is written
 * (`CLAUDE.md`, invariants).
 *
 * Pure and headless, like all of `core/draft`.
 */

import { withoutHiddenTags } from '../model/hidden-tags.js';
import type { FormatEntry, Token } from '../model/token.js';

/** `s` with `&`, `<` and `>` escaped, so none of it can read as markup. */
export function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The inverse of {@link escapeMarkup}; `&amp;` last, so `&amp;lt;` stays `&lt;`. */
export function unescapeMarkup(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * The file's ids of a source's visible tags, in the order each first appears
 * (an `open` or a `ph`; a `close` repeats its `open`). Index `i` is the tag
 * the engine sees as `t(i + 1)`.
 */
export function visibleTagIds(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): number[] {
  const ids: number[] = [];
  for (const token of withoutHiddenTags(tokens, formats)) {
    if ((token.t === 'open' || token.t === 'ph') && !ids.includes(token.id)) {
      ids.push(token.id);
    }
  }
  return ids;
}

/**
 * `tokens` as marked text. `promptIds` maps a file's tag id to its marker
 * number; a tag it does not name makes this return `null` rather than
 * invent a number or drop the tag, so a caller shows plain text instead.
 */
export function markTokens(
  tokens: readonly Token[],
  promptIds: ReadonlyMap<number, number>,
): string | null {
  let out = '';
  for (const token of tokens) {
    if (token.t === 'text') {
      out += escapeMarkup(token.v);
      continue;
    }
    const n = promptIds.get(token.id);
    if (n === undefined) return null;
    out += token.t === 'open' ? `<t${n}>` : token.t === 'close' ? `</t${n}>` : `<t${n}/>`;
  }
  return out;
}

/** One piece of a marked text: literal text, or a marker. */
export type MarkedPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'open' | 'close' | 'ph'; readonly n: number };

/** Why a marked text could not be read back. */
export interface MarkupError {
  readonly code: 'malformed_markup' | 'unknown_tag';
  readonly message: string;
}

const MARKER = /<(\/)?t(\d+)(\/)?>/g;

/**
 * Splits `text` into literal text and markers. An angle bracket left over
 * after the markers are taken — `<b>`, `<t3 />`, a half-written marker — is
 * `malformed_markup`: the prompt told the engine to write one as `&lt;`, so
 * a bare one is not text and is never guessed at. A marker numbered above
 * `tagCount`, or `0`, is `unknown_tag` (the engine invented one). A marker
 * written both ways, `</t1/>`, is malformed.
 */
export function parseMarked(
  text: string,
  tagCount: number,
):
  | { readonly ok: true; readonly pieces: MarkedPiece[] }
  | ({ readonly ok: false } & MarkupError) {
  const pieces: MarkedPiece[] = [];
  const literal = (raw: string): MarkupError | null => {
    if (/[<>]/.test(raw)) {
      return {
        code: 'malformed_markup',
        message: `an angle bracket that is not a tag marker, near ${JSON.stringify(raw.slice(0, 40))}`,
      };
    }
    if (raw !== '') pieces.push({ kind: 'text', text: unescapeMarkup(raw) });
    return null;
  };

  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const error = literal(text.slice(last, m.index));
    if (error) return { ok: false, ...error };
    last = m.index + m[0].length;
    const [, slash, digits, selfClose] = m;
    if (slash && selfClose) {
      return {
        ok: false,
        code: 'malformed_markup',
        message: `${m[0]} is neither a close nor a placeholder`,
      };
    }
    const n = Number(digits);
    if (n < 1 || n > tagCount) {
      return {
        ok: false,
        code: 'unknown_tag',
        message: `${m[0]} names a tag this segment does not have`,
      };
    }
    pieces.push({ kind: slash ? 'close' : selfClose ? 'ph' : 'open', n });
  }
  const error = literal(text.slice(last));
  if (error) return { ok: false, ...error };
  return { ok: true, pieces };
}
