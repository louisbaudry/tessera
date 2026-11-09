import { describe, expect, it } from 'vitest';

import {
  assignKey,
  DEFAULT_BINDINGS,
  formatCombo,
  parseBindings,
  refusalOf,
  resetBindings,
  resolveKey,
  SHORTCUT_ACTIONS,
  serializeBindings,
  type Combo,
  type ShortcutAction,
} from './shortcuts.js';

const ctrl = (code: string, shift = false): Combo => ({
  ctrl: true,
  shift,
  alt: false,
  meta: false,
  code,
});
const plain = (code: string): Combo => ({
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  code,
});

describe('the defaults', () => {
  it('are the keys the editor uses today, and each passes the rules against the others', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(
        refusalOf(action, DEFAULT_BINDINGS[action], DEFAULT_BINDINGS),
        action,
      ).toBeNull();
    }
    expect(DEFAULT_BINDINGS.palette).toEqual(ctrl('KeyK'));
    expect(DEFAULT_BINDINGS.filter).toEqual(ctrl('KeyF', true));
    expect(DEFAULT_BINDINGS.copySource).toEqual(ctrl('Insert'));
  });
});

describe('resolveKey', () => {
  it('finds the action a key press asks for, and nothing for a key no action uses', () => {
    const press = (combo: Combo) => ({
      ctrlKey: combo.ctrl,
      shiftKey: combo.shift,
      altKey: combo.alt,
      metaKey: combo.meta,
      code: combo.code,
    });
    expect(resolveKey(press(ctrl('KeyK')), DEFAULT_BINDINGS)).toBe('palette');
    expect(resolveKey(press(ctrl('KeyM', true)), DEFAULT_BINDINGS)).toBe('split');
    expect(resolveKey(press(ctrl('KeyM')), DEFAULT_BINDINGS)).toBe('merge');
    expect(resolveKey(press(plain('KeyK')), DEFAULT_BINDINGS)).toBeNull();
    expect(resolveKey(press(ctrl('KeyQ')), DEFAULT_BINDINGS)).toBeNull();
  });
});

describe('refusalOf', () => {
  it('refuses a key that would type over the text', () => {
    expect(refusalOf('palette', plain('KeyK'), DEFAULT_BINDINGS)).toMatch(
      /would type over the text/,
    );
  });

  it("refuses the editor's undo and redo, with Ctrl and with Meta (Cmd), and Ctrl+Shift+Z", () => {
    const meta = (code: string, shift = false): Combo => ({
      ctrl: false,
      shift,
      alt: false,
      meta: true,
      code,
    });
    expect(refusalOf('palette', ctrl('KeyZ'), DEFAULT_BINDINGS)).toMatch(/standard key/);
    expect(refusalOf('palette', ctrl('KeyY'), DEFAULT_BINDINGS)).toMatch(/standard key/);
    expect(refusalOf('palette', ctrl('KeyZ', true), DEFAULT_BINDINGS)).toMatch(
      /standard key/,
    );
    expect(refusalOf('palette', meta('KeyZ'), DEFAULT_BINDINGS)).toMatch(/standard key/);
    expect(refusalOf('palette', meta('KeyZ', true), DEFAULT_BINDINGS)).toMatch(
      /standard key/,
    );
    expect(refusalOf('palette', meta('KeyB'), DEFAULT_BINDINGS)).toMatch(/standard key/);
    // Alt is not the command modifier, so Alt+Z is free.
    expect(
      refusalOf(
        'palette',
        { ctrl: false, shift: false, alt: true, meta: false, code: 'KeyZ' },
        DEFAULT_BINDINGS,
      ),
    ).toBeNull();
  });

  it('refuses a key the browser or the editor already uses', () => {
    expect(refusalOf('palette', ctrl('KeyT'), DEFAULT_BINDINGS)).toMatch(/standard key/);
    expect(refusalOf('palette', ctrl('KeyB'), DEFAULT_BINDINGS)).toMatch(/standard key/);
    expect(refusalOf('palette', ctrl('KeyT', true), DEFAULT_BINDINGS)).toMatch(
      /standard key/,
    );
    expect(
      refusalOf('palette', { ...ctrl('KeyB'), alt: true }, DEFAULT_BINDINGS),
    ).toBeNull();
  });

  it('refuses a key the browser owns alone, and a code that is not a key name', () => {
    expect(
      refusalOf(
        'palette',
        { ctrl: true, shift: false, alt: false, meta: false, code: 'F5' },
        DEFAULT_BINDINGS,
      ),
    ).toMatch(/browser's own/);
    expect(refusalOf('palette', ctrl('ControlLeft'), DEFAULT_BINDINGS)).toMatch(
      /cannot be a shortcut key/,
    );
  });

  it('refuses a key another action already has, naming that action', () => {
    expect(refusalOf('palette', ctrl('KeyM'), DEFAULT_BINDINGS)).toBe(
      'Ctrl+M is already the key of "Merge with the next segment"',
    );
  });

  it('allows an action to keep its own key', () => {
    expect(refusalOf('palette', DEFAULT_BINDINGS.palette, DEFAULT_BINDINGS)).toBeNull();
  });
});

describe('assignKey', () => {
  it('changes one action and leaves the rest', () => {
    const result = assignKey(DEFAULT_BINDINGS, 'palette', ctrl('KeyJ'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindings.palette).toEqual(ctrl('KeyJ'));
      expect(result.bindings.merge).toEqual(DEFAULT_BINDINGS.merge);
    }
    // The defaults are not changed by the assignment.
    expect(DEFAULT_BINDINGS.palette).toEqual(ctrl('KeyK'));
  });

  it('changes nothing when a key is refused', () => {
    const result = assignKey(DEFAULT_BINDINGS, 'palette', ctrl('KeyM'));
    expect(result.ok).toBe(false);
  });
});

describe('storing bindings', () => {
  it('round-trips a changed set', () => {
    const changed = assignKey(DEFAULT_BINDINGS, 'palette', ctrl('KeyJ'));
    if (!changed.ok) throw new Error('setup');
    const parsed = parseBindings(serializeBindings(changed.bindings));
    expect(parsed.fellBack).toBe(false);
    expect(parsed.bindings).toEqual(changed.bindings);
  });

  it('is the defaults when nothing is stored', () => {
    expect(parseBindings(null)).toEqual({ bindings: resetBindings(), fellBack: false });
  });

  it('falls back to the defaults as a whole on text that is not JSON, or misses an action', () => {
    expect(parseBindings('not json')).toEqual({
      bindings: resetBindings(),
      fellBack: true,
    });
    const missing: Record<string, unknown> = { ...DEFAULT_BINDINGS };
    delete missing.merge;
    expect(parseBindings(JSON.stringify(missing)).fellBack).toBe(true);
  });

  it('falls back as a whole when a stored set holds a clash, not only the one entry', () => {
    const clashed = { ...DEFAULT_BINDINGS, palette: DEFAULT_BINDINGS.merge };
    const parsed = parseBindings(JSON.stringify(clashed));
    expect(parsed.fellBack).toBe(true);
    expect(parsed.bindings).toEqual(resetBindings());
  });

  it('falls back when a stored key is one the rules refuse', () => {
    const typed = { ...DEFAULT_BINDINGS, palette: plain('KeyK') };
    expect(parseBindings(JSON.stringify(typed)).fellBack).toBe(true);
  });
});

describe('formatCombo', () => {
  it('writes a combo as a person reads it', () => {
    expect(formatCombo(ctrl('KeyM', true))).toBe('Ctrl+Shift+M');
    expect(
      formatCombo({ ctrl: false, shift: false, alt: true, meta: false, code: 'Enter' }),
    ).toBe('Alt+Enter');
    expect(formatCombo(ctrl('Comma'))).toBe('Ctrl+Comma');
  });
});

describe('resetBindings', () => {
  it('is a copy of the defaults that a change cannot reach', () => {
    const reset = resetBindings();
    (reset as Record<ShortcutAction, Combo>).palette = ctrl('KeyJ');
    expect(DEFAULT_BINDINGS.palette).toEqual(ctrl('KeyK'));
  });
});
