/**
 * Assignable editor shortcuts (issue #193, follow-up to backlog #115): the
 * editor's actions, the key each one uses, and the rules for changing a key.
 * Pure, so every rule is provable in node; the handlers in `Grid.tsx` and
 * `TargetEditor.tsx` read the resolved key, and a settings screen (not yet
 * built) would write it through `parseBindings`/`serializeBindings`.
 *
 * A key is a physical key (`KeyboardEvent.code`, so a layout that moves a
 * letter does not move the shortcut) plus Ctrl, Shift, Alt and Meta. A binding
 * must hold at least one of Ctrl, Alt or Meta, so a letter never types over
 * the text; a key the browser, the OS or ProseMirror owns is refused; and two
 * actions cannot share a key. Stored bindings that fail any rule fall back to
 * the defaults as a whole, never partly: a half-read set would bind a key the
 * person did not choose.
 */

/** A physical key, as `KeyboardEvent.code` names it. */
export interface Combo {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly code: string;
}

/** The keyboard facts a resolve reads: a `KeyboardEvent` has all of them. */
export interface KeyFacts {
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly code: string;
}

/** The editor's actions a key can be given to. */
export const SHORTCUT_ACTIONS = [
  'merge',
  'split',
  'filter',
  'palette',
  'confirm',
  'nextTag',
  'tagList',
  'copySource',
  'acceptDraft',
  'addTerm',
  'concordance',
  'findReplace',
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** Each action's title, as the palette and the settings screen show it. */
export const SHORTCUT_TITLES: Readonly<Record<ShortcutAction, string>> = {
  merge: 'Merge with the next segment',
  split: 'Split at the caret',
  filter: 'Show the filter bar',
  palette: 'Open the command palette',
  confirm: 'Confirm the segment',
  nextTag: 'Place the next tag',
  tagList: 'Open the tag list',
  copySource: 'Copy the source',
  acceptDraft: 'Take the draft',
  addTerm: 'Add a term',
  concordance: 'Concordance search',
  findReplace: 'Find and replace',
};

/** The keys the editor uses today, so nothing changes until a person changes it. */
export const DEFAULT_BINDINGS: Readonly<Record<ShortcutAction, Combo>> = {
  merge: { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyM' },
  split: { ctrl: true, shift: true, alt: false, meta: false, code: 'KeyM' },
  filter: { ctrl: true, shift: true, alt: false, meta: false, code: 'KeyF' },
  palette: { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyK' },
  confirm: { ctrl: true, shift: false, alt: false, meta: false, code: 'Enter' },
  nextTag: { ctrl: true, shift: false, alt: false, meta: false, code: 'Comma' },
  tagList: { ctrl: true, shift: true, alt: false, meta: false, code: 'Comma' },
  copySource: { ctrl: true, shift: false, alt: false, meta: false, code: 'Insert' },
  acceptDraft: { ctrl: true, shift: false, alt: false, meta: false, code: 'Period' },
  addTerm: { ctrl: true, shift: true, alt: false, meta: false, code: 'KeyD' },
  concordance: { ctrl: true, shift: true, alt: false, meta: false, code: 'KeyL' },
  findReplace: { ctrl: true, shift: true, alt: false, meta: false, code: 'KeyH' },
};

/**
 * Ctrl combinations the browser, the OS or ProseMirror already uses in a text
 * editor, without Shift. A binding that matches one is refused, because the
 * page would never see the key or the person would lose a standard action.
 * Ctrl+Insert is not here: the editor has always used it for copy source, and
 * it is the default.
 */
const RESERVED_CTRL_CODES: ReadonlySet<string> = new Set([
  'KeyA',
  'KeyB',
  'KeyC',
  'KeyF',
  'KeyI',
  'KeyN',
  'KeyP',
  'KeyR',
  'KeyS',
  'KeyT',
  'KeyU',
  'KeyV',
  'KeyW',
  'KeyX',
  'KeyY',
  'KeyZ',
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
]);

/** Ctrl+Shift combinations the browser owns (reopen a tab, the dev tools, a window). */
const RESERVED_CTRL_SHIFT_CODES: ReadonlySet<string> = new Set([
  'KeyC',
  'KeyI',
  'KeyJ',
  'KeyN',
  'KeyT',
  'KeyW',
]);

/** Keys the browser owns on their own, whatever the modifiers. */
const RESERVED_ALONE_CODES: ReadonlySet<string> = new Set(['F5', 'F11', 'F12', 'Escape']);

/** Codes a binding may name: letters, digits, function keys and a few punctuation keys. */
const ASSIGNABLE_CODE =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Enter|Insert|Comma|Period|Space|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/;

/** Why a combo cannot be given to an action, or null when it can. */
export function refusalOf(
  action: ShortcutAction,
  combo: Combo,
  bindings: Readonly<Record<ShortcutAction, Combo>>,
): string | null {
  if (!ASSIGNABLE_CODE.test(combo.code))
    return `"${combo.code}" cannot be a shortcut key`;
  if (!combo.ctrl && !combo.alt && !combo.meta) {
    return 'a shortcut needs Ctrl, Alt or Meta, or it would type over the text';
  }
  if (combo.ctrl && !combo.alt && !combo.meta) {
    const reserved = combo.shift ? RESERVED_CTRL_SHIFT_CODES : RESERVED_CTRL_CODES;
    if (reserved.has(combo.code)) {
      return `${formatCombo(combo)} is a standard key of the browser or the editor`;
    }
  }
  if (RESERVED_ALONE_CODES.has(combo.code)) return `${combo.code} is the browser's own`;
  for (const other of SHORTCUT_ACTIONS) {
    if (other === action) continue;
    if (sameCombo(bindings[other], combo)) {
      return `${formatCombo(combo)} is already the key of "${SHORTCUT_TITLES[other]}"`;
    }
  }
  return null;
}

/** Whether two combos are the same key with the same modifiers. */
export function sameCombo(a: Combo, b: Combo): boolean {
  return (
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt &&
    a.meta === b.meta
  );
}

/** A combo as a person reads it: `Ctrl+Shift+M`, `Alt+Enter`. */
export function formatCombo(combo: Combo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.meta) parts.push('Meta');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  parts.push(combo.code.replace(/^Key/, '').replace(/^Digit/, ''));
  return parts.join('+');
}

/** The action a key press asks for under `bindings`, or null when none does. */
export function resolveKey(
  event: KeyFacts,
  bindings: Readonly<Record<ShortcutAction, Combo>>,
): ShortcutAction | null {
  const pressed: Combo = {
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    code: event.code,
  };
  for (const action of SHORTCUT_ACTIONS) {
    if (sameCombo(bindings[action], pressed)) return action;
  }
  return null;
}

/**
 * Bindings after one action is given a combo, or the reason it cannot be.
 * Nothing changes on a refusal, so the editor never runs on a half-made change.
 */
export function assignKey(
  bindings: Readonly<Record<ShortcutAction, Combo>>,
  action: ShortcutAction,
  combo: Combo,
): { ok: true; bindings: Record<ShortcutAction, Combo> } | { ok: false; reason: string } {
  const reason = refusalOf(action, combo, bindings);
  if (reason !== null) return { ok: false, reason };
  return { ok: true, bindings: { ...bindings, [action]: combo } };
}

/** The defaults, as a fresh object the caller may change. */
export function resetBindings(): Record<ShortcutAction, Combo> {
  return { ...DEFAULT_BINDINGS };
}

/** The bindings as JSON for a browser store. */
export function serializeBindings(
  bindings: Readonly<Record<ShortcutAction, Combo>>,
): string {
  return JSON.stringify(bindings);
}

const isCombo = (v: unknown): v is Combo => {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.code === 'string' &&
    typeof c.ctrl === 'boolean' &&
    typeof c.shift === 'boolean' &&
    typeof c.alt === 'boolean' &&
    typeof c.meta === 'boolean'
  );
};

/**
 * The bindings a store holds, or the defaults when the store is empty, not
 * JSON, missing an action, or holds a combo a rule refuses. The whole set
 * falls back, never one entry: a partial read could bind a key the person did
 * not choose.
 */
export function parseBindings(text: string | null): {
  bindings: Record<ShortcutAction, Combo>;
  fellBack: boolean;
} {
  if (text === null) return { bindings: resetBindings(), fellBack: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { bindings: resetBindings(), fellBack: true };
  }
  if (typeof raw !== 'object' || raw === null)
    return { bindings: resetBindings(), fellBack: true };
  const candidate = {} as Record<ShortcutAction, Combo>;
  for (const action of SHORTCUT_ACTIONS) {
    const value = (raw as Record<string, unknown>)[action];
    if (!isCombo(value)) return { bindings: resetBindings(), fellBack: true };
    candidate[action] = value;
  }
  for (const action of SHORTCUT_ACTIONS) {
    if (refusalOf(action, candidate[action], candidate) !== null) {
      return { bindings: resetBindings(), fellBack: true };
    }
  }
  return { bindings: candidate, fellBack: false };
}
