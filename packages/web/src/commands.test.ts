import { describe, expect, it } from 'vitest';

import {
  clampActive,
  filterCommands,
  isPaletteKey,
  moveActive,
  nextMarked,
  type CommandInfo,
} from './commands.js';

const cmds: CommandInfo[] = [
  { id: 'merge', title: 'Merge with next segment', hint: 'Ctrl+M' },
  { id: 'split', title: 'Split at source caret', hint: 'Ctrl+Shift+M' },
  { id: 'qa', title: 'Toggle QA panel', keywords: 'quality' },
  { id: 'gloss', title: 'Toggle glossary panel' },
  { id: 'next-qa', title: 'Go to next segment with a QA finding', keywords: 'issue' },
  { id: 'clear', title: 'Clear the filter' },
];
const ids = (list: readonly CommandInfo[]) => list.map((c) => c.id);

describe('filterCommands', () => {
  it('is every command, in order, for an empty query', () => {
    expect(ids(filterCommands(cmds, ''))).toEqual(ids(cmds));
    expect(ids(filterCommands(cmds, '   '))).toEqual(ids(cmds));
  });

  it('needs every word, in any order, and ignores case', () => {
    expect(ids(filterCommands(cmds, 'toggle qa'))).toEqual(['qa']);
    expect(ids(filterCommands(cmds, 'QA TOGGLE'))).toEqual(['qa']);
    expect(ids(filterCommands(cmds, 'toggle'))).toEqual(['qa', 'gloss']);
  });

  it('finds a command by a keyword that is not in its title', () => {
    expect(ids(filterCommands(cmds, 'quality'))).toEqual(['qa']);
    expect(ids(filterCommands(cmds, 'issue'))).toEqual(['next-qa']);
  });

  it('ranks a title that starts with a query word above one that only contains it', () => {
    // Both contain "qa" and neither title starts with it, so the original order stands.
    expect(ids(filterCommands(cmds, 'qa'))).toEqual(['qa', 'next-qa']);
    // Only "Go to next segment..." has both words.
    expect(ids(filterCommands(cmds, 'go qa'))).toEqual(['next-qa']);
    const more: CommandInfo[] = [
      { id: 'a', title: 'Show all clear' },
      { id: 'b', title: 'Clear the filter' },
    ];
    expect(ids(filterCommands(more, 'clear'))).toEqual(['b', 'a']);
  });

  it('keeps the original order within a rank, so the list never shuffles', () => {
    expect(ids(filterCommands(cmds, 'panel'))).toEqual(['qa', 'gloss']);
  });

  it('folds accents, so a query typed without them still finds the command', () => {
    const accented: CommandInfo[] = [{ id: 'x', title: 'Übersicht öffnen' }];
    expect(ids(filterCommands(accented, 'ubersicht'))).toEqual(['x']);
  });

  it('finds nothing for a word that is nowhere', () => {
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
  });
});

describe('moveActive / clampActive', () => {
  it('wraps at both ends', () => {
    expect(moveActive(0, 1, 3)).toBe(1);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, -1, 3)).toBe(2);
  });

  it('stays at 0 for an empty list, and clamps a highlight the list shrank under', () => {
    expect(moveActive(0, 1, 0)).toBe(0);
    expect(clampActive(5, 2)).toBe(1);
    expect(clampActive(-1, 2)).toBe(0);
    expect(clampActive(3, 0)).toBe(0);
  });
});

describe('isPaletteKey', () => {
  const key = (over: Partial<Parameters<typeof isPaletteKey>[0]>) => ({
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: 'KeyK',
    ...over,
  });

  it('is Ctrl+K or Cmd+K and nothing else', () => {
    expect(isPaletteKey(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteKey(key({ metaKey: true }))).toBe(true);
    expect(isPaletteKey(key({}))).toBe(false);
    expect(isPaletteKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteKey(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteKey(key({ ctrlKey: true, code: 'KeyJ' }))).toBe(false);
  });
});

describe('nextMarked', () => {
  const segs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  it('goes forward from the open segment and does not wrap', () => {
    const marked = new Set([2, 4]);
    expect(nextMarked(segs, marked, -1)).toBe(1);
    expect(nextMarked(segs, marked, 1)).toBe(3);
    expect(nextMarked(segs, marked, 3)).toBeNull();
  });
  it('reads a map as well as a set', () => {
    expect(nextMarked(segs, new Map([[3, 'x']]), 0)).toBe(2);
  });
});
