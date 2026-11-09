/**
 * The logic behind the editor-keys section of the Account screen (issue #193): what
 * the list shows for each action, and what one key press means while a person is
 * choosing a new key. Pure, so every rule is provable in node; `ShortcutSettings.tsx`
 * only renders it. The rules a key must meet (a modifier, not a reserved key, not
 * another action's) are `shortcuts.ts`'s, never restated here.
 */
import {
  assignKey,
  cmdAliasOf,
  DEFAULT_BINDINGS,
  formatCombo,
  SHORTCUT_ACTIONS,
  SHORTCUT_TITLES,
  sameCombo,
  type Combo,
  type KeyFacts,
  type ShortcutAction,
} from './shortcuts.js';

type Bindings = Readonly<Record<ShortcutAction, Combo>>;

/** `KeyboardEvent.code` of a key that is only a modifier: pressing it alone chooses nothing. */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'AltGraph',
  'CapsLock',
]);

/** One line of the list: an action, the key it has now, and what can be done to it. */
export interface ShortcutRow {
  readonly action: ShortcutAction;
  readonly title: string;
  /** The key as a person reads it, `Ctrl+Shift+M`. */
  readonly keys: string;
  /** The Cmd form that also answers on a Mac (palette and confirm only), or null. */
  readonly alias: string | null;
  /** Whether the action still has its default key; a reset of it would change nothing. */
  readonly isDefault: boolean;
}

/** The list, in the order the actions are declared. */
export function shortcutRows(bindings: Bindings): ShortcutRow[] {
  return SHORTCUT_ACTIONS.map((action) => {
    const alias = cmdAliasOf(bindings, action);
    return {
      action,
      title: SHORTCUT_TITLES[action],
      keys: formatCombo(bindings[action]),
      alias: alias === null ? null : formatCombo(alias),
      isDefault: sameCombo(bindings[action], DEFAULT_BINDINGS[action]),
    };
  });
}

/** Whether every action has its default key, so "Reset all" has nothing to do. */
export function allDefault(bindings: Bindings): boolean {
  return SHORTCUT_ACTIONS.every((a) => sameCombo(bindings[a], DEFAULT_BINDINGS[a]));
}

/** What one key press did while an action was waiting for its new key. */
export type CaptureOutcome =
  | { readonly kind: 'wait' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'set'; readonly bindings: Record<ShortcutAction, Combo> };

/**
 * Reads one key press as the new key of `action`. A modifier on its own is
 * `wait` (the person is still building the combination); Escape is `cancel`, which
 * is also why it can never be a binding; any other key is given to the action or
 * `refused` with the reason from `refusalOf`, leaving the bindings as they were.
 */
export function captureOutcome(
  bindings: Bindings,
  action: ShortcutAction,
  event: KeyFacts,
): CaptureOutcome {
  if (event.code === 'Escape') return { kind: 'cancel' };
  if (event.code === '' || MODIFIER_CODES.has(event.code)) return { kind: 'wait' };
  const result = assignKey(bindings, action, {
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    code: event.code,
  });
  return result.ok
    ? { kind: 'set', bindings: result.bindings }
    : { kind: 'refused', reason: result.reason };
}

/**
 * One action back to its default key, or the reason it cannot: another action may
 * hold that key now, and two actions never share one.
 */
export function resetAction(
  bindings: Bindings,
  action: ShortcutAction,
): { ok: true; bindings: Record<ShortcutAction, Combo> } | { ok: false; reason: string } {
  return assignKey(bindings, action, DEFAULT_BINDINGS[action]);
}
