import { describe, expect, it } from 'vitest';

import {
  nextThemeChoice,
  parseThemeChoice,
  resolveTheme,
  type ThemeChoice,
} from './theme.js';

describe('parseThemeChoice', () => {
  it('reads the three choices and falls back to system', () => {
    expect(parseThemeChoice('light')).toBe('light');
    expect(parseThemeChoice('dark')).toBe('dark');
    expect(parseThemeChoice('system')).toBe('system');
    expect(parseThemeChoice(null)).toBe('system');
    expect(parseThemeChoice('sepia')).toBe('system');
  });
});

describe('nextThemeChoice', () => {
  it('cycles system → light → dark → system', () => {
    const seen: ThemeChoice[] = ['system'];
    for (let i = 0; i < 3; i++) seen.push(nextThemeChoice(seen[i]!));
    expect(seen).toEqual(['system', 'light', 'dark', 'system']);
  });
});

describe('resolveTheme', () => {
  it('follows the OS only under system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
