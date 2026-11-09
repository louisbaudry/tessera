import { describe, expect, it } from 'vitest';

import {
  allDefault,
  captureOutcome,
  resetAction,
  shortcutRows,
} from './shortcut-settings.js';
import { DEFAULT_BINDINGS, resetBindings } from './shortcuts.js';

const press = (code: string, mods: Partial<Record<string, boolean>> = {}) => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('shortcutRows', () => {
  it('lists every action with its key as a person reads it', () => {
    const rows = shortcutRows(DEFAULT_BINDINGS);
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.action === 'nextTag')?.keys).toBe('Ctrl+,');
    expect(rows.find((r) => r.action === 'split')?.keys).toBe('Ctrl+Shift+M');
    expect(rows.every((r) => r.isDefault)).toBe(true);
  });

  it('names the Cmd key that also works for the palette and confirm, and for nothing else', () => {
    const rows = shortcutRows(DEFAULT_BINDINGS);
    expect(rows.find((r) => r.action === 'palette')?.alias).toBe('Meta+K');
    expect(rows.find((r) => r.action === 'confirm')?.alias).toBe('Meta+Enter');
    expect(rows.filter((r) => r.alias !== null)).toHaveLength(2);
  });

  it('marks a changed action as not default', () => {
    const changed = {
      ...DEFAULT_BINDINGS,
      palette: { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyJ' },
    };
    const rows = shortcutRows(changed);
    expect(rows.find((r) => r.action === 'palette')?.isDefault).toBe(false);
    expect(rows.find((r) => r.action === 'merge')?.isDefault).toBe(true);
  });
});

describe('allDefault', () => {
  it('is true for the defaults and false after one change', () => {
    expect(allDefault(resetBindings())).toBe(true);
    expect(
      allDefault({
        ...DEFAULT_BINDINGS,
        palette: { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyJ' },
      }),
    ).toBe(false);
  });
});

describe('captureOutcome', () => {
  it('waits while only a modifier is down', () => {
    for (const code of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaLeft']) {
      expect(
        captureOutcome(DEFAULT_BINDINGS, 'palette', press(code, { ctrlKey: true })),
      ).toEqual({ kind: 'wait' });
    }
  });

  it('cancels on Escape, which is why it can never be assigned', () => {
    expect(captureOutcome(DEFAULT_BINDINGS, 'palette', press('Escape'))).toEqual({
      kind: 'cancel',
    });
  });

  it('gives the pressed key to the action', () => {
    const out = captureOutcome(
      DEFAULT_BINDINGS,
      'palette',
      press('KeyJ', { ctrlKey: true }),
    );
    expect(out.kind).toBe('set');
    if (out.kind === 'set') {
      expect(out.bindings.palette).toEqual({
        ctrl: true,
        shift: false,
        alt: false,
        meta: false,
        code: 'KeyJ',
      });
      expect(out.bindings.merge).toEqual(DEFAULT_BINDINGS.merge);
    }
  });

  it('refuses a key with no modifier, a reserved key and another action’s key, with the reason', () => {
    const bare = captureOutcome(DEFAULT_BINDINGS, 'palette', press('KeyJ'));
    expect(bare).toMatchObject({ kind: 'refused' });
    const reserved = captureOutcome(
      DEFAULT_BINDINGS,
      'palette',
      press('KeyW', { ctrlKey: true }),
    );
    expect(reserved).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/standard key/),
    });
    const taken = captureOutcome(
      DEFAULT_BINDINGS,
      'palette',
      press('KeyM', { ctrlKey: true }),
    );
    expect(taken).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/Merge with the next segment/),
    });
  });

  it('refuses Tab, which no shortcut may use', () => {
    expect(
      captureOutcome(DEFAULT_BINDINGS, 'palette', press('Tab', { ctrlKey: true })),
    ).toMatchObject({ kind: 'refused' });
  });
});

describe('resetAction', () => {
  it('restores one action to its default and leaves the others', () => {
    const changed = {
      ...DEFAULT_BINDINGS,
      palette: { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyJ' },
      merge: { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyG' },
    };
    const out = resetAction(changed, 'palette');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.bindings.palette).toEqual(DEFAULT_BINDINGS.palette);
      expect(out.bindings.merge).toEqual(changed.merge);
    }
  });

  it('is refused while another action holds the default key', () => {
    const changed = {
      ...DEFAULT_BINDINGS,
      // merge takes palette's default key (Ctrl+K) after palette moved away.
      palette: { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyJ' },
      merge: DEFAULT_BINDINGS.palette,
    };
    const out = resetAction(changed, 'palette');
    expect(out).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Merge with the next segment/),
    });
  });
});
