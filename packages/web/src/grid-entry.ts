/**
 * Which segment the grid opens when a person presses Enter on it (issue #193, the
 * accessibility audit, `planning/accessibility-audit.md` finding K1).
 *
 * Before this the only way to open a segment was a mouse click on its target cell (or the
 * command palette's two "go to" commands), so a person using the keyboard alone could not
 * open the segment in front of them.
 *
 * `moveCursor` is the row cursor that followed (issue #391, finding K4): with the grid
 * focused and no segment open, the arrow keys move a visible cursor from row to row, so any
 * segment can be reached and then opened with Enter, without a mouse and without opening
 * every segment on the way.
 */

/** What the choice reads of a segment. */
export interface EntrySegment {
  readonly id: number;
  /** A locked segment cannot be opened for editing. */
  readonly editable: boolean;
}

/**
 * The index, among the segments shown, of the one to open.
 *
 * The segment the person last left with Escape wins while it is still shown, so Escape then
 * Enter returns to the same place. Otherwise it is the first editable segment at or after the
 * top of the visible part of the grid, else the nearest editable one before it.
 *
 * @param shown the segments the filter shows, in order.
 * @param lastLeftId the id of the segment last left with Escape, or null.
 * @param firstVisible the index of the first segment in view (clamped into range).
 * @returns an index into `shown`, or null when no shown segment can be edited.
 */
export function segmentToOpen(
  shown: readonly EntrySegment[],
  lastLeftId: number | null,
  firstVisible: number,
): number | null {
  if (lastLeftId !== null) {
    const last = shown.findIndex((s) => s.id === lastLeftId);
    if (last !== -1 && shown[last]!.editable) return last;
  }
  const from = Math.min(Math.max(0, firstVisible), Math.max(0, shown.length - 1));
  for (let i = from; i < shown.length; i += 1) if (shown[i]!.editable) return i;
  for (let i = from - 1; i >= 0; i -= 1) if (shown[i]!.editable) return i;
  return null;
}

/** The keys that move the grid's row cursor. */
export const CURSOR_KEYS = [
  'ArrowDown',
  'ArrowUp',
  'PageDown',
  'PageUp',
  'Home',
  'End',
] as const;
export type CursorKey = (typeof CURSOR_KEYS)[number];

/** Whether `key` (a `KeyboardEvent.key`) moves the row cursor. */
export function isCursorKey(key: string): key is CursorKey {
  return (CURSOR_KEYS as readonly string[]).includes(key);
}

/** How many rows Page Up and Page Down move the cursor. */
export const CURSOR_PAGE = 10;

/**
 * Where the row cursor goes for one key press. Every shown row can hold the cursor, a locked
 * one too: the cursor is for reading as well as for opening, and Enter on a locked row does
 * nothing.
 *
 * @param count how many segments the filter shows.
 * @param current the cursor's index among them, or null when there is no cursor yet.
 * @param start where a first press puts the cursor: the row last left, or the first in view.
 * @param key the key pressed.
 * @returns the new index, clamped to the list, or null when no segment is shown. A first
 *   press lands on `start` whatever the arrow, so the cursor appears where the person is
 *   looking before it moves; Home and End go to the ends at once.
 */
export function moveCursor(
  count: number,
  current: number | null,
  start: number,
  key: CursorKey,
): number | null {
  if (count === 0) return null;
  const clamp = (i: number): number => Math.min(Math.max(0, i), count - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (current === null || current < 0 || current >= count) return clamp(start);
  switch (key) {
    case 'ArrowDown':
      return clamp(current + 1);
    case 'ArrowUp':
      return clamp(current - 1);
    case 'PageDown':
      return clamp(current + CURSOR_PAGE);
    case 'PageUp':
      return clamp(current - CURSOR_PAGE);
  }
}
