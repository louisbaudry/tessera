/**
 * The editor's command palette (backlog #115; issue #175): what a query finds
 * among the commands and how the highlighted row moves. The key that opens it is
 * `shortcuts.ts`'s (issue #193).
 * Pure, so each is provable in node; `CommandPalette.tsx` renders and
 * `Grid.tsx` says what the commands do.
 */

/** What the palette needs to show and find a command; `Grid` adds what it runs. */
export interface CommandInfo {
  readonly id: string;
  readonly title: string;
  /** The key that does it without the palette, written as the editor's tooltips do. */
  readonly hint?: string;
  /** Extra words that find it but are not shown, e.g. a synonym. */
  readonly keywords?: string;
}

const norm = (s: string): string =>
  s.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * The commands a query finds, best first. Every word of the query must occur
 * in the command's title or keywords, in any order, so "toggle qa" and
 * "qa toggle" both find "Toggle QA panel". A title that starts with a word of
 * the query ranks above one that merely contains it, and within a rank the
 * original order stays, so the palette is the same list every time it opens.
 * An empty query is every command, in order.
 */
export function filterCommands<T extends CommandInfo>(
  commands: readonly T[],
  query: string,
): T[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  const scored: Array<{ command: T; rank: number; at: number }> = [];
  commands.forEach((command, at) => {
    const title = norm(command.title);
    const haystack = `${title} ${norm(command.keywords ?? '')}`;
    if (!words.every((w) => haystack.includes(w))) return;
    const rank = words.some((w) => title.startsWith(w)) ? 0 : 1;
    scored.push({ command, rank, at });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.at - b.at).map((s) => s.command);
}

/** The highlighted row after an arrow key: it wraps, so the end is one key from the start. */
export function moveActive(active: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return 0;
  return (active + delta + length) % length;
}

/** Keeps the highlight on a real row when the list shrinks under it. */
export const clampActive = (active: number, length: number): number =>
  length <= 0 ? 0 : Math.min(Math.max(active, 0), length - 1);

/**
 * The next segment after `from` (an index; -1 for "before the first") with a
 * QA mark, forward only and without wrapping, as confirm-and-advance goes.
 */
export function nextMarked(
  segments: readonly { readonly id: number }[],
  marked: ReadonlySet<number> | ReadonlyMap<number, unknown>,
  from: number,
): number | null {
  for (let i = from + 1; i < segments.length; i++) {
    if (marked.has(segments[i]!.id)) return i;
  }
  return null;
}
