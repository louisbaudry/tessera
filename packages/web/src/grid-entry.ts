/**
 * Which segment the grid opens when a person presses Enter on it (issue #193, the
 * accessibility audit, `planning/accessibility-audit.md` finding K1).
 *
 * Before this the only way to open a segment was a mouse click on its target cell (or the
 * command palette's two "go to" commands), so a person using the keyboard alone could not
 * open the segment in front of them.
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
