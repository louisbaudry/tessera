/**
 * Keeping the Tab key inside an open dialog (issue #193, the accessibility audit,
 * `planning/accessibility-audit.md` finding K3).
 *
 * The editor's dialogs say `aria-modal="true"` and cover the page with a backdrop a mouse
 * cannot click through, but Tab walked out of them into the page behind, where Escape no
 * longer closed the dialog. `wrapIndex` is the rule, pure and tested in node; `keepFocusInside`
 * applies it to a real key press.
 */

/** What a dialog's Tab handling needs of a key event: a `KeyboardEvent` has all of it. */
export interface TabKey {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

/** What can take focus inside a dialog, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Where Tab should go when the browser's own move would leave the dialog.
 *
 * @param count how many elements in the dialog can take focus.
 * @param current the index of the focused one among them, or -1 when focus is elsewhere.
 * @param backwards true for Shift+Tab.
 * @returns the index to focus instead, or null to let the browser move focus itself (the
 *   move stays inside), or -1 when nothing in the dialog can take focus (the key is
 *   swallowed so focus stays where it is).
 */
export function wrapIndex(
  count: number,
  current: number,
  backwards: boolean,
): number | null {
  if (count === 0) return -1;
  if (current === -1) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : null;
  return current === count - 1 ? 0 : null;
}

/**
 * Handles a key press for a modal dialog: a Tab that would leave `dialog` goes to its other
 * end instead. Every other key is left alone.
 *
 * @param event the key press, from the dialog's `onKeyDown`.
 * @param dialog the dialog's own element.
 */
export function keepFocusInside(event: TabKey, dialog: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // An element that is not laid out (a hidden step of a form) cannot take focus.
    (el) => el.getClientRects().length > 0,
  );
  const to = wrapIndex(
    items.length,
    items.indexOf(document.activeElement as HTMLElement),
    event.shiftKey,
  );
  if (to === null) return;
  event.preventDefault();
  items[to]?.focus();
}
