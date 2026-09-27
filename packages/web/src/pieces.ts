/**
 * A segment's tokens as the grid shows them (v1-spec.md §7.1): text runs
 * and read-only tag chips, numbered by tag id. A tag the filter marked
 * invisible (`FormatEntry.visible`, §3.3 — spell-check markers,
 * bookmarks) is not shown at all; it travels with the segment and is
 * re-emitted on export whether or not anyone saw it.
 *
 * `@cat-tool/core` is types only here, but for its browser-safe
 * `@cat-tool/core/model` entry — the tag rules, not the DOCX filter.
 */
import type { FormatEntry, TagKind, Token } from '@cat-tool/core';
import { withoutHiddenTags } from '@cat-tool/core/model';

import { describeFormat } from './tag-label.js';
import { collapseGroups } from './tags.js';

export type Piece =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tag';
      readonly role: 'open' | 'close' | 'ph';
      readonly id: number;
      /** Null when the token's `fmt` points nowhere in the table. */
      readonly tagKind: TagKind | null;
      /** The chip's label: the id in angle marks (`tagLabel`). */
      readonly label: string;
      /** The label with "show full tags" on: the id and the format in words. */
      readonly full: string;
      /** What the tag is, in words: the chip's tooltip. */
      readonly title: string;
    };

// U+2039 / U+203A (single angle quotes) and U+27E8 / U+27E9 (mathematical
// angle brackets), escaped per CLAUDE.md: they are lookalikes of < and >.
const OPEN = '\u2039';
const CLOSE = '\u203A';
const PH_OPEN = '\u27E8';
const PH_CLOSE = '\u27E9';

/** A chip's number: its id, or a group's first and last (`1–31`). */
const number = (id: number, last?: number): string =>
  last === undefined ? String(id) : `${id}\u2013${last}`;

export function tagLabel(
  role: 'open' | 'close' | 'ph',
  id: number,
  last?: number,
): string {
  const n = number(id, last);
  switch (role) {
    case 'open':
      return `${OPEN}${n}`;
    case 'close':
      return `${n}${CLOSE}`;
    case 'ph':
      return `${PH_OPEN}${n}${PH_CLOSE}`;
  }
}

/** A chip's label with its format in words: the id, then `bold`, `footnote`. */
export function fullTagLabel(
  role: 'open' | 'close' | 'ph',
  id: number,
  words: string,
  last?: number,
): string {
  const n = number(id, last);
  switch (role) {
    case 'open':
      return `${OPEN}${n} ${words}`;
    case 'close':
      return `${words} ${n}${CLOSE}`;
    case 'ph':
      return `${PH_OPEN}${n} ${words}${PH_CLOSE}`;
  }
}

/** A tag's words, and a group's size: `bold`, `bold, 31 runs as one`. */
export function tagTitle(words: string, members: readonly number[]): string {
  return members.length === 0 ? words : `${words}, ${members.length + 1} runs as one`;
}

/**
 * The pieces of a segment's source or target: hidden tags dropped (`core`'s
 * rule), each group of look-alike pairs (`pairGroups`, from the source)
 * shown as one pair, numbered by its first and last id.
 */
export function toPieces(
  tokens: readonly Token[],
  formatTable: readonly FormatEntry[],
  groups: ReadonlyMap<number, readonly number[]> = new Map(),
): Piece[] {
  const formats = new Map(formatTable.map((f) => [f.id, f]));
  const collapsed = collapseGroups(withoutHiddenTags(tokens, formatTable), groups);
  const out: Piece[] = [];
  for (const token of collapsed.tokens) {
    if (token.t === 'text') {
      const last = out[out.length - 1];
      if (last?.kind === 'text')
        out[out.length - 1] = { kind: 'text', text: last.text + token.v };
      else if (token.v !== '') out.push({ kind: 'text', text: token.v });
      continue;
    }
    // A close carries no `fmt`; its id is its open's.
    const format = formats.get(token.t === 'close' ? token.id : token.fmt);
    const members = collapsed.grouped.has(token.id) ? (groups.get(token.id) ?? []) : [];
    const lastId = members.length > 1 ? members[members.length - 1] : undefined;
    const words = describeFormat(format);
    out.push({
      kind: 'tag',
      role: token.t,
      id: token.id,
      tagKind: format?.kind ?? null,
      label: tagLabel(token.t, token.id, lastId),
      full: fullTagLabel(token.t, token.id, words, lastId),
      title: tagTitle(words, members.slice(1)),
    });
  }
  return out;
}
