import { describe, expect, it } from 'vitest';

import type { GlossaryRefView, TmRefView } from './api.js';
import {
  anonymousRows,
  glossaryRows,
  memoryRows,
  OUTSIDE_NAME,
  resourceSummary,
} from './resources.js';

const tm = (over: Partial<TmRefView> & { id: number }): TmRefView => ({
  tm: `tm-${over.id}`,
  priority: over.id,
  writeTarget: false,
  enabled: true,
  ...over,
});

describe('memoryRows', () => {
  it('lists memories in the order they are consulted, whatever order the server sent', () => {
    const rows = memoryRows([
      tm({ id: 1, priority: 3 }),
      tm({ id: 2, priority: 1 }),
      tm({ id: 3, priority: 2 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['tm-2', 'tm-3', 'tm-1']);
  });

  it('breaks a tie by id, so the order never shuffles between loads', () => {
    const rows = memoryRows([tm({ id: 9, priority: 1 }), tm({ id: 4, priority: 1 })]);
    expect(rows.map((r) => r.id)).toEqual([4, 9]);
  });

  it('says which one is written to and which are switched off', () => {
    const [first, second, third] = memoryRows([
      tm({ id: 1, writeTarget: true }),
      tm({ id: 2, enabled: false }),
      tm({ id: 3, writeTarget: true, enabled: false }),
    ]);
    expect(first!.badges).toEqual(['writes here']);
    expect(second!.badges).toEqual(['off']);
    expect(third!.badges).toEqual(['writes here', 'off']);
    expect([first!.enabled, second!.enabled]).toEqual([true, false]);
  });

  it('names a memory attached from outside the account plainly, never by a path', () => {
    const [row] = memoryRows([tm({ id: 1, tm: null })]);
    expect(row!.name).toBe(OUTSIDE_NAME);
  });
});

describe('glossaryRows', () => {
  it('reads the glossary slug and orders the same way', () => {
    const refs: GlossaryRefView[] = [
      { id: 2, glossary: 'client', priority: 2, writeTarget: true, enabled: true },
      { id: 1, glossary: 'base', priority: 1, writeTarget: false, enabled: true },
    ];
    expect(glossaryRows(refs).map((r) => [r.name, r.badges])).toEqual([
      ['base', []],
      ['client', ['writes here']],
    ]);
  });
});

describe('resourceSummary', () => {
  it('counts, in the singular where it is one', () => {
    expect(resourceSummary(1, 1)).toBe('1 memory, 1 glossary');
    expect(resourceSummary(0, 2)).toBe('0 memories, 2 glossaries');
  });
});

describe('anonymousRows', () => {
  it('names rows by position and never by anything about the file', () => {
    const rows = anonymousRows(
      [
        { writeTarget: false, enabled: true },
        { writeTarget: true, enabled: false },
      ],
      'Memory',
    );
    expect(rows.map((r) => r.name)).toEqual(['Memory 1', 'Memory 2']);
    expect(rows[1]).toMatchObject({ badges: ['writes here', 'off'], enabled: false });
    expect(rows[0]).toMatchObject({ badges: [], enabled: true });
  });

  it('keeps the order the server gave and numbers glossaries on their own', () => {
    const rows = anonymousRows([{ writeTarget: true, enabled: true }], 'Glossary');
    expect(rows).toEqual([
      { id: 1, name: 'Glossary 1', badges: ['writes here'], enabled: true },
    ]);
    expect(anonymousRows([], 'Memory')).toEqual([]);
  });
});
