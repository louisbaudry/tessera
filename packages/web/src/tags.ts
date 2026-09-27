/**
 * The tag rules of the target editor (v1-spec.md §3.3, §7.2), as pure
 * functions over tag sequences — no editor, no DOM. The editor
 * (`target-doc.ts`) holds its content as ProseMirror nodes and asks these
 * what may be placed and what must go.
 *
 * The invariant they keep is the one `renderTokens` would otherwise
 * refuse at export (backlog #10): pairs matched, nested and never
 * interleaved, no id twice. The editor starts from a valid target —
 * repairing a stored one that is not — and only ever types text, deletes
 * whole pairs, and wraps balanced selections, so an invalid one is
 * unreachable rather than rejected.
 *
 * Which tags are hidden is `core`'s rule, imported from its browser-safe
 * entry (`@cat-tool/core/model`), not restated here: the server applies
 * the same one when it carries them (`carryHiddenTags`).
 */
import type { FormatEntry, TagKind, Token } from '@cat-tool/core';
import { withoutHiddenTags } from '@cat-tool/core/model';

import { describeFormat } from './tag-label.js';

/** A tag the translator may place: one of the source's visible tags. */
export interface PaletteTag {
  readonly role: 'pair' | 'ph';
  readonly id: number;
  readonly fmt: number;
  /** Null when the format table cannot explain it. */
  readonly kind: TagKind | null;
  /**
   * The pairs placed with this one, as one (`pairGroups`): ids that
   * follow it, formatted the same, with nothing visible between.
   */
  readonly members: readonly number[];
}

const formatsById = (formats: readonly FormatEntry[]) =>
  new Map(formats.map((f) => [f.id, f]));

/**
 * Runs of visible formatting pairs a reader cannot tell apart, keyed by
 * their first id, each the ids in order (two or more).
 *
 * Word splits a run wherever anything changes, seen or not — a
 * spell-check marker, a revision id, kerning on one space — so one bold
 * phrase can arrive as many bold pairs, side by side: one fixture sentence
 * has 31, the corpus has such runs in 251 of 2,602 segments. Placing each
 * would be busywork, and each one left out a blocking `tag.missing`. So
 * pairs that follow one another directly (only hidden tags between) and
 * whose formatting reads the same (`describeFormat`) are placed as one:
 * the first wraps the text, the rest follow it empty, and export renders
 * the text with the first one's properties — what differs between them
 * is what no chip ever showed, the same trade the hidden runs make.
 */
export function pairGroups(
  source: readonly Token[],
  formats: readonly FormatEntry[],
): ReadonlyMap<number, readonly number[]> {
  const byId = formatsById(formats);
  const visible = withoutHiddenTags(source, formats);
  const next = new Map<number, number>();
  const follows = new Set<number>();
  for (let i = 0; i + 1 < visible.length; i++) {
    const a = visible[i]!;
    const b = visible[i + 1]!;
    if (a.t !== 'close' || b.t !== 'open') continue;
    const fa = byId.get(a.id);
    const fb = byId.get(b.fmt);
    if (fa?.placement !== 'run' || fb?.placement !== 'run') continue;
    if (describeFormat(fa) !== describeFormat(fb)) continue;
    next.set(a.id, b.id);
    follows.add(b.id);
  }
  const groups = new Map<number, number[]>();
  for (const first of next.keys()) {
    if (follows.has(first)) continue;
    const ids = [first];
    for (let id = next.get(first); id !== undefined; id = next.get(id)) ids.push(id);
    groups.set(first, ids);
  }
  return groups;
}

/** The source's visible tags, in source order: what there is to place. */
export function paletteOf(
  source: readonly Token[],
  formatTable: readonly FormatEntry[],
): PaletteTag[] {
  const byId = formatsById(formatTable);
  const groups = pairGroups(source, formatTable);
  const members = new Set([...groups.values()].flatMap((ids) => ids.slice(1)));
  const out: PaletteTag[] = [];
  for (const token of withoutHiddenTags(source, formatTable)) {
    if (token.t !== 'open' && token.t !== 'ph') continue;
    if (token.t === 'open' && members.has(token.id)) continue;
    out.push({
      role: token.t === 'open' ? 'pair' : 'ph',
      id: token.id,
      fmt: token.fmt,
      kind: byId.get(token.fmt)?.kind ?? null,
      members: token.t === 'open' ? (groups.get(token.id)?.slice(1) ?? []) : [],
    });
  }
  return out;
}

/**
 * A visible target with each group (`pairGroups`) it places whole held as
 * its first pair: a chain of the members' pairs side by side (a copy of
 * the source) becomes the first pair around all their content, and
 * members following it empty (what the editor saves) are dropped.
 * `grouped` says which first ids now stand for their group. A group
 * placed any other way — a member alone, elsewhere — is left as it is,
 * each pair its own chip.
 */
export function collapseGroups(
  tokens: readonly Token[],
  groups: ReadonlyMap<number, readonly number[]>,
): { tokens: Token[]; grouped: Set<number> } {
  let out = [...tokens];
  const grouped = new Set<number>();
  for (const [first, ids] of groups) {
    const at = (t: 'open' | 'close', id: number) =>
      out.findIndex((token) => token.t === t && token.id === id);
    if (at('open', first) < 0 || at('close', first) < 0) continue;
    const present = ids
      .slice(1)
      .filter((id) => at('open', id) >= 0 || at('close', id) >= 0);
    if (present.length === 0) {
      grouped.add(first);
      continue;
    }
    if (present.length !== ids.length - 1) continue;
    const chained = ids.every(
      (id, i) =>
        i === ids.length - 1 ||
        (at('close', id) >= 0 &&
          out[at('close', id) + 1]?.t === 'open' &&
          (out[at('close', id) + 1] as { id: number }).id === ids[i + 1]),
    );
    if (!chained) continue;
    const drop = new Set<number>();
    for (let i = 0; i < ids.length - 1; i++) {
      drop.add(at('close', ids[i]!));
      drop.add(at('open', ids[i + 1]!));
    }
    const last = at('close', ids[ids.length - 1]!);
    out = out.flatMap((token, i): Token[] =>
      drop.has(i) ? [] : i === last ? [{ t: 'close', id: first }] : [token],
    );
    grouped.add(first);
  }
  return { tokens: out, grouped };
}

/**
 * The inverse, for saving: each grouped first pair followed by its
 * members, empty. The server stores every tag the source has; export
 * drops the empty ones and renders the text with the first.
 */
export function expandGroups(
  tokens: readonly Token[],
  members: ReadonlyMap<number, readonly number[]>,
): Token[] {
  return tokens.flatMap((token): Token[] => {
    const ids = token.t === 'close' ? members.get(token.id) : undefined;
    if (!ids) return [token];
    return [
      token,
      ...ids.flatMap((id): Token[] => [
        { t: 'open', id, fmt: id },
        { t: 'close', id },
      ]),
    ];
  });
}

/** Palette tags the target has not placed yet, in source order. */
export function unplacedTags(
  palette: readonly PaletteTag[],
  target: readonly Token[],
): PaletteTag[] {
  const placed = new Set<string>();
  for (const token of target) {
    if (token.t === 'open') placed.add(`pair${token.id}`);
    else if (token.t === 'ph') placed.add(`ph${token.id}`);
  }
  return palette.filter((tag) => !placed.has(`${tag.role}${tag.id}`));
}

/** A tag chip as the editor holds it, in document order. */
export interface Chip {
  readonly role: 'open' | 'close' | 'ph';
  readonly id: number;
}

/**
 * Which chips (by index) must go so that the rest is valid: a second
 * chip with the same role and id, the half of a pair whose partner is
 * gone or comes first, and both halves of a pair that would interleave
 * with another. A pair is always removed whole — deleting either chip of
 * a pair deletes its partner, and the content between stays.
 */
export function chipsToDrop(chips: readonly Chip[]): Set<number> {
  const drop = new Set<number>();
  const seen = new Set<string>();
  chips.forEach((chip, i) => {
    const key = `${chip.role}${chip.id}`;
    if (seen.has(key)) drop.add(i);
    seen.add(key);
  });

  for (;;) {
    const opens = new Map<number, number>();
    const closes = new Map<number, number>();
    chips.forEach((chip, i) => {
      if (drop.has(i)) return;
      if (chip.role === 'open') opens.set(chip.id, i);
      if (chip.role === 'close') closes.set(chip.id, i);
    });
    // Orphans, and a close before its own open.
    for (const [id, i] of opens) {
      const j = closes.get(id);
      if (j === undefined || j < i) {
        drop.add(i);
        if (j !== undefined) drop.add(j);
      }
    }
    for (const [id, j] of closes) if (!opens.has(id)) drop.add(j);

    // Interleaving: the first close that is not the innermost open pair
    // takes its whole pair out, then the check runs again.
    const stack: number[] = [];
    let crossed: number | null = null;
    for (let i = 0; i < chips.length && crossed === null; i++) {
      const chip = chips[i]!;
      if (drop.has(i) || chip.role === 'ph') continue;
      if (chip.role === 'open') stack.push(chip.id);
      else if (stack[stack.length - 1] === chip.id) stack.pop();
      else crossed = chip.id;
    }
    const o = crossed === null ? undefined : opens.get(crossed);
    const c = crossed === null ? undefined : closes.get(crossed);
    // Every pass drops a whole pair or stops, so this always ends.
    if (o === undefined || c === undefined) return drop;
    drop.add(o);
    drop.add(c);
  }
}

/**
 * Whether the chips inside a selection may be wrapped in a new pair:
 * every pair with a chip inside has both inside. Then the selection
 * starts and ends inside the same pairs, and wrapping it nests.
 */
export function isBalanced(chips: readonly Chip[]): boolean {
  const open = new Set<number>();
  for (const chip of chips) {
    if (chip.role === 'open') open.add(chip.id);
    else if (chip.role === 'close' && !open.delete(chip.id)) return false;
  }
  return open.size === 0;
}

/** What the nesting rule needs to know of a pair. */
export interface PairShape {
  readonly placement: FormatEntry['placement'] | undefined;
  readonly kind: TagKind | null;
}

/**
 * Why a pair may not be placed where it would go, or null when it may.
 * A placed pair nests the way the source's do, because the renderer can
 * only express those (`renderTokens`): a run tag is a whole `w:rPr`, so
 * formatting inside formatting would keep only the inner one — bold
 * placed around italic exports as italic, silently. So a formatting
 * (`run`) pair holds only text and placeholders and sits in no other,
 * and a link does not go inside or around a link.
 */
export function nestingRefusal(
  pair: PairShape,
  around: readonly PairShape[],
  inside: readonly PairShape[],
): string | null {
  if (around.some((p) => p.placement === 'run')) {
    return 'formatting holds only text and placeholders, not other tags';
  }
  if (pair.placement === 'run' && inside.length > 0) {
    return 'formatting can wrap only text and placeholders, not other tags';
  }
  if (pair.kind === 'link' && [...around, ...inside].some((p) => p.kind === 'link')) {
    return 'a link cannot go inside another link';
  }
  return null;
}

/**
 * A committed target without the pairs that hold nothing. An empty pair
 * formats nothing and exports as nothing, so it counts as unplaced —
 * which QA's `tag.missing` then says — rather than as a tag placed.
 */
export function withoutEmptyPairs(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const previous = out[out.length - 1];
    if (token.t === 'close' && previous?.t === 'open' && previous.id === token.id) {
      out.pop();
      continue;
    }
    if (token.t === 'text' && token.v === '') continue;
    out.push(token);
  }
  return out;
}

/**
 * Pasted text as it may enter a segment: one line of printable text.
 * Line breaks and tabs are structure a translator places as tags (`w:br`,
 * `w:tab`), not characters, and a vertical tab or form feed is how other
 * programs write them: each run of those becomes one space. Any other
 * control character is dropped — the server refuses text XML cannot
 * carry, and a paste should not be where that is discovered.
 */
export function pastedText(text: string): string {
  return text
    .replace(/[\r\n\t\u000B\u000C\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '');
}
