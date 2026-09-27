/**
 * A segment's tokens as the grid shows them (v1-spec.md §7.1): text runs
 * and read-only tag chips, numbered by tag id. A tag the filter marked
 * invisible (`FormatEntry.visible`, §3.3 — spell-check markers,
 * bookmarks) is not shown at all; it travels with the segment and is
 * re-emitted on export whether or not anyone saw it.
 *
 * Types only from `@cat-tool/core`: its runtime is not for a browser.
 */
import type { FormatEntry, TagKind, Token } from '@cat-tool/core';

export type Piece =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tag';
      readonly role: 'open' | 'close' | 'ph';
      readonly id: number;
      /** Null when the token's `fmt` points nowhere in the table. */
      readonly tagKind: TagKind | null;
      readonly label: string;
    };

// U+2039 / U+203A (single angle quotes) and U+27E8 / U+27E9 (mathematical
// angle brackets), escaped per CLAUDE.md: they are lookalikes of < and >.
const OPEN = '\u2039';
const CLOSE = '\u203A';
const PH_OPEN = '\u27E8';
const PH_CLOSE = '\u27E9';

export function tagLabel(role: 'open' | 'close' | 'ph', id: number): string {
  switch (role) {
    case 'open':
      return `${OPEN}${id}`;
    case 'close':
      return `${id}${CLOSE}`;
    case 'ph':
      return `${PH_OPEN}${id}${PH_CLOSE}`;
  }
}

export function toPieces(
  tokens: readonly Token[],
  formatTable: readonly FormatEntry[],
): Piece[] {
  const formats = new Map(formatTable.map((f) => [f.id, f]));
  // A close carries no `fmt`: it takes its open's.
  const openFmt = new Map<number, number>();
  for (const token of tokens) if (token.t === 'open') openFmt.set(token.id, token.fmt);

  const out: Piece[] = [];
  for (const token of tokens) {
    if (token.t === 'text') {
      const last = out[out.length - 1];
      if (last?.kind === 'text')
        out[out.length - 1] = { kind: 'text', text: last.text + token.v };
      else if (token.v !== '') out.push({ kind: 'text', text: token.v });
      continue;
    }
    const fmt = token.t === 'close' ? openFmt.get(token.id) : token.fmt;
    const format = fmt === undefined ? undefined : formats.get(fmt);
    // Hidden only when the table says so; a tag it cannot explain is shown.
    if (format && !format.visible) continue;
    out.push({
      kind: 'tag',
      role: token.t,
      id: token.id,
      tagKind: format?.kind ?? null,
      label: tagLabel(token.t, token.id),
    });
  }
  return out;
}
